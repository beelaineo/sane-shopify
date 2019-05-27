import { Product, Collection, ShopifyClient } from '@sane-shopify/types'
import { from, empty, of } from 'rxjs'
import { unwindEdges } from '@good-idea/unwind-edges'
import { isMatch } from 'lodash'
import {
	map,
	mergeMap,
	expand,
	concatMap,
	delay,
	// take,
} from 'rxjs/operators'
import {
	PRODUCTS_QUERY,
	ProductsQueryResult,
	COLLECTIONS_QUERY,
	CollectionsQueryResult,
	PRODUCT_QUERY,
	ProductQueryResult,
} from './shopifyQueries'

export interface SyncingClient {
	syncProducts: (cbs: SubscriptionCallbacks<Product>) => void
	syncCollections: (cbs: SubscriptionCallbacks<Collection>) => void
	syncProductByHandle: (
		handle: string,
		cbs: SubscriptionCallbacks<Product>,
	) => void
	syncCollectionByHandle: (
		handle: string,
		cbs: SubscriptionCallbacks<Collection>,
	) => void
}

interface SubscriptionCallbacks<NodeType> {
	onFetchedItems?: (nodes: NodeType[]) => void
	onProgress?: (node: NodeType) => void
	onError?: (err: Error) => void
	onComplete?: () => void
}

const getItemType = (item: Product | Collection) => {
	switch (item.__typename) {
		case 'Product':
			return 'shopifyProduct'
		case 'Collection':
			return 'shopifyCollection'
		case undefined:
			throw new Error('The supplied item does not have a __typename')
		default:
			throw new Error(
				// @ts-ignore
				`The __typename '${item.__typename}' is not currently supported`,
			)
	}
}

export const createSyncingClient = (
	shopifyClient: ShopifyClient,
	sanityClient: any,
): SyncingClient => {
	/**
	 * Sanity
	 */

	const createSanityDocument = (item: Product | Collection) => {
		const _type = getItemType(item)
		const newDoc = {
			_type,
			shopifyId: item.id,
			slug: {
				current: item.handle,
			},
			__sourceInfo: {
				...item,
			},
		}
		return from(sanityClient.create(newDoc))
	}

	const updateSanityDocument = (doc: any, item: Product | Collection) => {
		const update = {
			slug: {
				current: item.handle,
			},
			__sourceInfo: {
				...item,
			},
		}
		return isMatch(doc, update)
			? of(doc).pipe(map(doc => ({ operation: 'skip', doc })))
			: from(
					sanityClient
						.patch(doc._id)
						.set(update)
						.commit(),
			  ).pipe(map(doc => ({ operation: 'updated', doc })))
	}

	const syncItem = (item: Product | Collection) => {
		const _type = getItemType(item)
		const sync$ = from(
			sanityClient.fetch('*[_type == $_type && shopifyId == $shopifyId][0]', {
				shopifyId: item.id,
				_type,
			}),
		).pipe(
			delay(100),
			mergeMap((doc: any) => {
				return doc
					? updateSanityDocument(doc, item)
					: createSanityDocument(item)
			}),
		)
		return sync$
	}

	/**
	 * Shopify
	 */
	const fetchProduct = (handle: string) =>
		from(
			shopifyClient.query<ProductQueryResult>(PRODUCT_QUERY, { handle }),
		).pipe(map(response => response.data.productByHandle))

	const fetchAll = <T extends ProductsQueryResult | CollectionsQueryResult>(
		type: 'products' | 'collections',
		onFetchedItems?: (nodes: any[]) => void,
	) => {
		const query = type === 'products' ? PRODUCTS_QUERY : COLLECTIONS_QUERY
		const fetchPage = (after?: string) =>
			from(shopifyClient.query<T>(query, { first: 25, after })).pipe(
				map(response => {
					const [nodes, { pageInfo, lastCursor }] = unwindEdges(
						response.data[type],
					)
					if (onFetchedItems) onFetchedItems(nodes)
					return {
						nodes,
						next: pageInfo.hasNextPage ? () => fetchPage(lastCursor) : empty,
					}
				}),
			)

		const allItemsStream = fetchPage().pipe(
			/* continue calling the next() function. If there are no more pages, this will run emtpy() */
			expand(({ next }) => next()),
			/* Turn each node result into an event */
			concatMap(({ nodes }) => nodes),
		)

		return allItemsStream
	}

	const syncItems = <ItemType = Product | Collection>(
		itemType: 'products' | 'collections',
	) => ({
		onFetchedItems,
		onProgress,
		onError,
		onComplete,
	}: SubscriptionCallbacks<ItemType> = {}) =>
		new Promise(resolve => {
			const products$ = fetchAll(itemType, onFetchedItems)
				.pipe(
					mergeMap((node: Product) => syncItem(node), undefined, 25),
					// take(22), // Uncomment for debugging
				)
				.subscribe(
					(item: ItemType) => onProgress && onProgress(item),
					error => onError && onError(error),
					() => {
						onComplete()
						resolve()
					},
				)
			return products$
		})

	const syncItemByHandle = <ItemType = Product | Collection>(
		itemType: 'product' | 'collection',
	) => (
		handle,
		{ onProgress, onError, onComplete }: SubscriptionCallbacks<ItemType> = {},
	) => {
		const product$ = fetchProduct(handle)
			.pipe(mergeMap((node: Product) => syncItem(node)))
			.subscribe(
				//@ts-ignore
				product => onProgress && onProgress(product),
				error => onError && onError(error),
				() => onComplete && onComplete(),
			)
	}

	/**
	 * Public API
	 */
	const syncProducts = syncItems<Product>('products')
	const syncCollections = syncItems<Collection>('collections')

	const syncProductByHandle = syncItemByHandle<Product>('product')
	const syncCollectionByHandle = syncItemByHandle<Collection>('collection')

	return {
		syncProducts,
		syncCollections,
		syncCollectionByHandle,
		syncProductByHandle,
	}
}
