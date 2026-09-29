# G4 events — local

Run start: 2026-09-29T00:13:34.543Z

| Scenario | Iterations | IDs covered / expected | Events (total counts) | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| fixture.product.create | 1 | 14/14 | product.product-option.created: 1, product.product-option-value.created: 3, product.product.created: 1, product.product-product-option-value.created: 3, product.product-product-option.created: 1, LinkProductSalesChannel.attached: 1, LinkProductShippingProfile.attached: 1, product.product-variant.created: 3, inventory.inventory-item.created: 3, inventory-item.created: 3, LinkProductVariantInventoryItem.attached: 1, pricing.price-set.created: 3, pricing.price.created: 3, LinkProductVariantPriceSet.attached: 1, product-variant.created: 3, product.created: 1 | 183 | 186 | -194 | -191 |
| fixture.inventory.levels | 3 | 3/6 | inventory.inventory-level.created: 3, inventory-level.created: 3 | 16 | 23 | -2 | -2 |
| product.update | 5 | 5/5 | product.product.updated: 5, product.updated: 5 | 64 | 87 | -69 | -59 |
| variant.update | 5 | 5/5 | product-variant.updated: 5, product.product-variant.updated: 5 | 25 | 32 | -74 | -70 |
| variant.prices | 5 | 10/10 | product.product-variant.updated: 5, pricing.price.updated: 5, product-variant.updated: 5 | 48 | 113 | -74 | -66 |
| inventory.level | 5 | 5/10 | inventory.inventory-level.updated: 5, inventory-level.updated: 5 | 24 | 29 | -10 | -9 |
| inventory.batch | 3 | 9/18 | inventory-level.updated: 9, inventory.inventory-level.updated: 9 | 39 | 61 | -3 | -2 |
| option.value.add | 3 | 6/9 | product.product-option-value.created: 3, product.product-option.updated: 3, product.product-option-value.updated: 9, product-option.updated: 3 | 33 | 40 | -20 | -20 |
| option.value.remove | 3 | 6/9 | product.product-option-value.updated: 9, product.product-option.updated: 3, product.product-option-value.deleted: 3, product-option.updated: 3 | 30 | 30 | -21 | -13 |
| link.channel.add | 3 | 0/3 | LinkProductSalesChannel.attached: 3 | 15 | 15 | -6 | -4 |
| link.channel.remove | 3 | 0/3 | LinkProductSalesChannel.detached: 3 | 18 | 19 | -4 | -4 |
| product.channels.replace | 3 | 3/3 | LinkProductSalesChannel.detached: 3, product.updated: 3, LinkProductSalesChannel.attached: 3 | 66 | 75 | -72 | -61 |
| price-list.create | 1 | 10/10 | pricing.price-list.created: 1, pricing.price.created: 9 | 31 | 32 | -12 | -11 |
| price-list.batch | 3 | 12/18 | pricing.price.deleted: 3, pricing.price.created: 6, pricing.price.updated: 3 | 66 | 74 | -22 | -22 |
| price-list.update | 3 | 0/3 | — | — | — | — | — |
| price-list.status | 4 | 0/4 | — | — | — | — | — |
| price-list.burst.create | 1 | 1/1 | pricing.price.created: 500, pricing.price-list.created: 1 | 1087 | 1103 | -105 | -89 |
| price-list.burst.delete | 1 | 0/1 | pricing.price.deleted: 500 | 25475 | 25479 | -38 | -34 |
| direct.module.writes | 1 | 0/3 | — | — | — | — | — |
| direct.module.writes.child-probe | 1 | 0/3 | server: —; child: pricing.price.updated: 1, inventory.inventory-level.updated: 1, product.product-variant.updated: 1 | — | — | — | — |

| Event | Count | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| product.product-option.created | 1 | 182 | 182 | -195 | -195 |
| product.product-option-value.created | 6 | 39 | 183 | -194 | -20 |
| product.product.created | 1 | 183 | 183 | -194 | -194 |
| product.product-product-option-value.created | 3 | 183 | 183 | -194 | -194 |
| product.product-product-option.created | 1 | 183 | 183 | -194 | -194 |
| LinkProductSalesChannel.attached | 7 | 56 | 183 | -61 | -4 |
| LinkProductShippingProfile.attached | 1 | 183 | 183 | -194 | -194 |
| product.product-variant.created | 3 | 183 | 183 | -194 | -194 |
| inventory.inventory-item.created | 3 | 183 | 184 | -194 | -193 |
| inventory-item.created | 3 | 184 | 184 | -193 | -193 |
| LinkProductVariantInventoryItem.attached | 1 | 184 | 184 | -193 | -193 |
| pricing.price-set.created | 3 | 184 | 184 | -193 | -193 |
| pricing.price.created | 518 | 1086 | 1103 | -105 | -89 |
| LinkProductVariantPriceSet.attached | 1 | 185 | 185 | -192 | -192 |
| product-variant.created | 3 | 186 | 186 | -191 | -191 |
| product.created | 1 | 186 | 186 | -191 | -191 |
| inventory.inventory-level.created | 3 | 16 | 23 | -2 | -2 |
| inventory-level.created | 3 | 16 | 23 | -2 | -2 |
| product.product.updated | 5 | 64 | 87 | -69 | -60 |
| product.updated | 8 | 65 | 87 | -72 | -59 |
| product-variant.updated | 10 | 32 | 113 | -74 | -66 |
| product.product-variant.updated | 10 | 31 | 113 | -74 | -66 |
| pricing.price.updated | 8 | 50 | 113 | -73 | -22 |
| inventory.inventory-level.updated | 14 | 32 | 51 | -9 | -3 |
| inventory-level.updated | 14 | 33 | 61 | -5 | -2 |
| product.product-option.updated | 6 | 30 | 40 | -21 | -13 |
| product.product-option-value.updated | 18 | 30 | 40 | -21 | -13 |
| product-option.updated | 6 | 30 | 40 | -21 | -13 |
| product.product-option-value.deleted | 3 | 30 | 30 | -21 | -13 |
| LinkProductSalesChannel.detached | 6 | 19 | 74 | -61 | -4 |
| pricing.price-list.created | 2 | 31 | 939 | -253 | -12 |
| pricing.price.deleted | 503 | 25475 | 25479 | -38 | -34 |

price-list.burst.delete: 500 events; drain time (max fromResponse): -34 ms
