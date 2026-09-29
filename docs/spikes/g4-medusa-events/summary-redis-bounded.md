# G4 events — redis

Run start: 2026-09-29T00:30:09.064Z

Unattributed events: 0

| Scenario | Iterations | IDs covered / expected | Events (total counts) | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| fixture.product.create | 1 | 14/14 | inventory-item.created: 3, product-variant.created: 3, product.created: 1, product.product-option.created: 1, product.product-option-value.created: 3, product.product.created: 1, product.product-product-option.created: 1, product.product-product-option-value.created: 3, LinkProductSalesChannel.attached: 1, LinkProductShippingProfile.attached: 1, product.product-variant.created: 3, inventory.inventory-item.created: 3, LinkProductVariantInventoryItem.attached: 1, pricing.price-set.created: 3, pricing.price.created: 3, LinkProductVariantPriceSet.attached: 1 | 548 | 562 | 239 | 253 |
| fixture.inventory.levels | 3 | 3/6 | inventory-level.created: 3, inventory.inventory-level.created: 3 | 23 | 39 | 2 | 9 |
| product.update | 5 | 5/5 | product.updated: 5, product.product.updated: 5 | 102 | 181 | -61 | 13 |
| variant.update | 5 | 5/5 | product-variant.updated: 5, product.product-variant.updated: 5 | 59 | 349 | -64 | 136 |
| variant.prices | 5 | 10/10 | product-variant.updated: 5, product.product-variant.updated: 5, pricing.price.updated: 5 | 147 | 185 | 4 | 7 |
| inventory.level | 5 | 5/10 | inventory-level.updated: 5, inventory.inventory-level.updated: 5 | 38 | 55 | 0 | 2 |
| inventory.batch | 3 | 9/18 | inventory-level.updated: 9, inventory.inventory-level.updated: 9 | 40 | 48 | 5 | 10 |
| option.value.add | 3 | 6/9 | product-option.updated: 3, product.product-option-value.created: 3, product.product-option.updated: 3, product.product-option-value.updated: 9 | 106 | 267 | 50 | 146 |
| option.value.remove | 3 | 6/9 | product-option.updated: 3, product.product-option.updated: 3, product.product-option-value.updated: 9, product.product-option-value.deleted: 3 | 93 | 95 | 48 | 51 |
| link.channel.add | 3 | 0/3 | LinkProductSalesChannel.attached: 3 | 20 | 26 | 0 | 0 |
| link.channel.remove | 3 | 0/3 | LinkProductSalesChannel.detached: 3 | 26 | 56 | 0 | 3 |
| product.channels.replace | 3 | 3/3 | product.updated: 3, LinkProductSalesChannel.detached: 3, LinkProductSalesChannel.attached: 3 | 143 | 182 | 4 | 21 |
| price-list.create | 1 | 10/10 | pricing.price-list.created: 1, pricing.price.created: 9 | 44 | 50 | 2 | 8 |
| price-list.batch | 3 | 15/18 | pricing.price.deleted: 3, pricing.price.created: 6, pricing.price.updated: 6 | 90 | 142 | 0 | 5 |
| price-list.update | 3 | 0/3 | — | — | — | — | — |
| price-list.status | 4 | 0/4 | — | — | — | — | — |
| price-list.burst.create | 1 | 1/1 | pricing.price-list.created: 1, pricing.price.created: 500 | 596 | 797 | 195 | 396 |
| price-list.burst.delete | 1 | 0/1 | pricing.price.deleted: 500 | 9911 | 10069 | 158 | 316 |
| direct.module.writes | 1 | 0/3 | — | — | — | — | — |
| direct.module.writes.child-probe | 1 | 3/3 | server: pricing.price.updated: 1, inventory.inventory-level.updated: 1, product.product-variant.updated: 1; child: — | 7485 | 7508 | -67 | -44 |

| Event | Count | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| inventory-item.created | 3 | 257 | 263 | -52 | -46 |
| product-variant.created | 3 | 354 | 422 | 45 | 113 |
| product.created | 1 | 483 | 483 | 174 | 174 |
| product.product-option.created | 1 | 534 | 534 | 225 | 225 |
| product.product-option-value.created | 6 | 262 | 538 | 141 | 229 |
| product.product.created | 1 | 539 | 539 | 230 | 230 |
| product.product-product-option.created | 1 | 540 | 540 | 231 | 231 |
| product.product-product-option-value.created | 3 | 541 | 548 | 232 | 239 |
| LinkProductSalesChannel.attached | 7 | 143 | 550 | 5 | 241 |
| LinkProductShippingProfile.attached | 1 | 551 | 551 | 242 | 242 |
| product.product-variant.created | 3 | 553 | 553 | 244 | 244 |
| inventory.inventory-item.created | 3 | 555 | 555 | 246 | 246 |
| LinkProductVariantInventoryItem.attached | 1 | 556 | 556 | 247 | 247 |
| pricing.price-set.created | 3 | 557 | 558 | 248 | 249 |
| pricing.price.created | 518 | 590 | 797 | 191 | 396 |
| LinkProductVariantPriceSet.attached | 1 | 563 | 563 | 254 | 254 |
| inventory-level.created | 3 | 22 | 32 | 2 | 2 |
| inventory.inventory-level.created | 3 | 23 | 39 | 3 | 9 |
| product.updated | 8 | 77 | 102 | -67 | -61 |
| product.product.updated | 5 | 154 | 181 | 8 | 13 |
| product-variant.updated | 10 | 59 | 94 | -82 | -64 |
| product.product-variant.updated | 11 | 148 | 7508 | 5 | 136 |
| pricing.price.updated | 12 | 142 | 7462 | 3 | 7 |
| inventory-level.updated | 14 | 38 | 53 | 3 | 7 |
| inventory.inventory-level.updated | 15 | 41 | 7485 | 6 | 10 |
| product-option.updated | 6 | 41 | 97 | -6 | 0 |
| product.product-option.updated | 6 | 92 | 264 | 47 | 143 |
| product.product-option-value.updated | 18 | 94 | 267 | 49 | 146 |
| product.product-option-value.deleted | 3 | 95 | 95 | 50 | 51 |
| LinkProductSalesChannel.detached | 6 | 56 | 181 | 3 | 20 |
| pricing.price-list.created | 2 | 39 | 414 | -3 | 13 |
| pricing.price.deleted | 503 | 9910 | 10069 | 157 | 316 |

price-list.burst.delete: 500 events; drain time (max fromResponse): 332 ms
