import { defineMiddlewares } from '@medusajs/framework/http'

// The starter template configures `/store/search` here with
// `configureStoreSearch`, which first ships in @medusajs/framework 2.21.1.
// This dev store is pinned to 2.21.0 (2.21.1 was under a day old, inside the
// 24h minimum-release-age rule) and has no storefront, so the route is left
// unconfigured. Restore it when upgrading.
export default defineMiddlewares({
  routes: [],
})
