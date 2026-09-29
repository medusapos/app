# G4 events — redis

Run start: 2026-09-29T00:09:22.491Z

| Scenario | Iterations | IDs covered / expected | Events (total counts) | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| fixture.product.create | 1 | 14/14 | inventory-item.created: 3, product-variant.created: 3, product.created: 1, product.product-option.created: 1, product.product-option-value.created: 3, product.product.created: 1, product.product-product-option.created: 1, product.product-product-option-value.created: 3, LinkProductSalesChannel.attached: 1, LinkProductShippingProfile.attached: 1, product.product-variant.created: 3, inventory.inventory-item.created: 3, LinkProductVariantInventoryItem.attached: 1, pricing.price-set.created: 3, pricing.price.created: 3, LinkProductVariantPriceSet.attached: 1 | 586 | 600 | 227 | 241 |
| fixture.inventory.levels | 3 | 3/6 | inventory-level.created: 3, inventory.inventory-level.created: 3 | 20 | 41 | 2 | 5 |
| product.update | 5 | 5/5 | product.updated: 5, product.product.updated: 5 | 75 | 161 | -56 | 9 |
| variant.update | 5 | 5/5 | product-variant.updated: 5, product.product-variant.updated: 5 | 95 | 252 | -47 | 19 |
| variant.prices | 5 | 10/10 | product-variant.updated: 5, product.product-variant.updated: 5, pricing.price.updated: 5 | 118 | 125 | 4 | 19 |
| inventory.level | 5 | 5/10 | inventory-level.updated: 5, inventory.inventory-level.updated: 5 | 33 | 38 | 0 | 2 |
| inventory.batch | 3 | 9/18 | inventory-level.updated: 9, inventory.inventory-level.updated: 9 | 38 | 42 | 4 | 10 |
| option.value.add | 3 | 6/9 | product-option.updated: 3, product.product-option-value.created: 3, product.product-option.updated: 3, product.product-option-value.updated: 9 | 97 | 109 | 49 | 54 |
| option.value.remove | 3 | 6/9 | product-option.updated: 3, product.product-option.updated: 3, product.product-option-value.updated: 9, product.product-option-value.deleted: 3 | 96 | 226 | 48 | 148 |
| link.channel.add | 3 | 0/3 | LinkProductSalesChannel.attached: 3 | 23 | 24 | 0 | 1 |
| link.channel.remove | 3 | 0/3 | LinkProductSalesChannel.detached: 3 | 23 | 25 | 0 | 1 |
| product.channels.replace | 3 | 3/3 | product.updated: 3, LinkProductSalesChannel.detached: 3, LinkProductSalesChannel.attached: 3 | 147 | 194 | 5 | 22 |
| price-list.create | 1 | 10/10 | pricing.price-list.created: 1, pricing.price.created: 9 | 49 | 53 | 4 | 8 |
| price-list.batch | 3 | 12/18 | pricing.price.deleted: 3, pricing.price.created: 6, pricing.price.updated: 3 | 80 | 102 | 0 | 4 |
| price-list.update | 3 | 0/3 | — | — | — | — | — |
| price-list.status | 4 | 0/4 | — | — | — | — | — |
| price-list.burst.create | 1 | 1/1 | pricing.price-list.created: 1, pricing.price.created: 500 | 423 | 516 | 95 | 188 |
| price-list.burst.delete | 1 | 0/1 | pricing.price.deleted: 500 | 9932 | 10001 | 112 | 181 |
| direct.module.writes | 1 | 0/3 | — | — | — | — | — |
| direct.module.writes.child-probe | 1 | 3/3 | server: pricing.price.updated: 1, inventory.inventory-level.updated: 1, product.product-variant.updated: 1; child: — | 6594 | 6617 | -69 | -46 |

| Event | Count | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| inventory-item.created | 3 | 297 | 300 | -62 | -59 |
| product-variant.created | 3 | 400 | 474 | 41 | 115 |
| product.created | 1 | 531 | 531 | 172 | 172 |
| product.product-option.created | 1 | 577 | 577 | 218 | 218 |
| product.product-option-value.created | 6 | 104 | 581 | 49 | 222 |
| product.product.created | 1 | 582 | 582 | 223 | 223 |
| product.product-product-option.created | 1 | 583 | 583 | 224 | 224 |
| product.product-product-option-value.created | 3 | 585 | 586 | 226 | 227 |
| LinkProductSalesChannel.attached | 7 | 147 | 587 | 5 | 228 |
| LinkProductShippingProfile.attached | 1 | 588 | 588 | 229 | 229 |
| product.product-variant.created | 3 | 590 | 591 | 231 | 232 |
| inventory.inventory-item.created | 3 | 593 | 594 | 234 | 235 |
| LinkProductVariantInventoryItem.attached | 1 | 595 | 595 | 236 | 236 |
| pricing.price-set.created | 3 | 597 | 598 | 238 | 239 |
| pricing.price.created | 518 | 421 | 518 | 93 | 190 |
| LinkProductVariantPriceSet.attached | 1 | 601 | 601 | 242 | 242 |
| inventory-level.created | 3 | 20 | 39 | 2 | 3 |
| inventory.inventory-level.created | 3 | 21 | 41 | 3 | 5 |
| product.updated | 8 | 75 | 92 | -66 | -56 |
| product.product.updated | 5 | 140 | 161 | 5 | 9 |
| product-variant.updated | 10 | 53 | 180 | -61 | -46 |
| product.product-variant.updated | 11 | 122 | 6617 | 5 | 19 |
| pricing.price.updated | 9 | 119 | 6572 | 4 | 19 |
| inventory-level.updated | 14 | 35 | 40 | 2 | 5 |
| inventory.inventory-level.updated | 15 | 38 | 6594 | 5 | 10 |
| product-option.updated | 6 | 42 | 53 | -7 | -5 |
| product.product-option.updated | 6 | 94 | 211 | 47 | 133 |
| product.product-option-value.updated | 18 | 97 | 221 | 50 | 143 |
| product.product-option-value.deleted | 3 | 98 | 226 | 51 | 148 |
| LinkProductSalesChannel.detached | 6 | 25 | 192 | 1 | 21 |
| pricing.price-list.created | 2 | 42 | 344 | -3 | 16 |
| pricing.price.deleted | 503 | 9931 | 10001 | 111 | 181 |

price-list.burst.delete: 500 events; drain time (max fromResponse): 191 ms
