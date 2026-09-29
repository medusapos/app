import { readFile, writeFile } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
import { spawn } from "node:child_process"

const [baseUrl, probeFile, resultsFile] = process.argv.slice(2)
const startedAt = Date.now()
const records = []
const bus = process.env.G4_EVENT_BUS
const fixture = { variantIds: [], priceIds: [], inventoryItemIds: [], levelIds: [] }

function ids(value) {
  if (Array.isArray(value)) {
    return value.flatMap(ids)
  }
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) =>
    (key === "id" || key.endsWith("_id")) && typeof item === "string" ? [item]
      : key.endsWith("_ids") && Array.isArray(item)
        ? item.flatMap(value => typeof value === "string" ? [value] : ids(value)) : ids(item))
}

async function measure(scenario, iteration, write, expectedIds) {
  const t0 = Date.now()
  const response = await write()
  const body = await response.text()
  const t1 = response.exitedAt ?? Date.now()
  let quietSince = t1
  let previousLines = -1
  let lines
  while (true) {
    const text = await readFile(probeFile, "utf8")
    lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean)
    const now = Date.now()
    if (lines.length !== previousLines) {
      previousLines = lines.length
      quietSince = now
    }
    if ((now - t1 >= 3000 && now - quietSince >= 1000) || now - t1 >= 15000) break
    await setTimeout(50)
  }
  const events = lines.map(line => JSON.parse(line))
    .filter(event => event.receivedAt >= t0)
    .map(event => ({ name: event.name, receivedAt: event.receivedAt, ids: ids(event.data),
      fromStart: event.receivedAt - t0, fromResponse: event.receivedAt - t1 }))
  const record = { scenario, iteration, t0, t1, status: response.status, expectedIds, events }
  records.push(record)
  if (!response.ok) throw new Error(`${scenario} ${iteration} failed: ${response.status} ${body}`)
  return { record, data: JSON.parse(body) }
}

try {
  const login = await fetch(`${baseUrl}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "g4@tally.test", password: "g4-probe-password" }),
  })
  if (!login.ok) throw new Error(`Login failed: ${login.status}`)
  const { token } = await login.json()
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  const lookup = {}
  for (const route of ["sales-channels", "stock-locations", "regions", "shipping-profiles"]) {
    const response = await fetch(`${baseUrl}/admin/${route}`, { headers })
    if (!response.ok) throw new Error(`${route} listing failed: ${response.status} ${await response.text()}`)
    Object.assign(lookup, await response.json())
  }
  const defaultChannel = lookup.sales_channels.find(channel => channel.name === "Default Sales Channel")
  const otherChannel = lookup.sales_channels.find(channel => channel.name === "E2E other channel")
  const location = lookup.stock_locations.find(location => location.name === "Copenhagen")
  const region = lookup.regions.find(region => region.name === "Europe")
  const profile = lookup.shipping_profiles.find(profile => profile.type === "default")
  const sizes = ["S", "M", "L"]
  fixture.locationId = location.id
  fixture.salesChannelIds = [defaultChannel.id, otherChannel.id]
  const creation = await measure("fixture.product.create", 1, () => fetch(`${baseUrl}/admin/products`, {
    method: "POST", headers,
    body: JSON.stringify({
      title: "G4 probe product", status: "published", shipping_profile_id: profile.id,
      sales_channels: [{ id: defaultChannel.id }], options: [{ title: "Size", values: sizes }],
      variants: sizes.map(size => ({ title: size, sku: `G4-${size}`, options: { Size: size },
        manage_inventory: true, prices: [{ currency_code: region.currency_code, amount: 10 }] })),
    }),
  }), [])
  fixture.productId = creation.data.product.id
  const readback = await fetch(`${baseUrl}/admin/products/${fixture.productId}?fields=*variants,*variants.prices,*options,*options.values,*variants.inventory_items`, { headers })
  if (!readback.ok) throw new Error(`Product readback failed: ${readback.status} ${await readback.text()}`)
  const { product } = await readback.json()
  const variants = sizes.map(size => product.variants.find(variant => variant.sku === `G4-${size}`))
  const option = product.options.find(option => option.title === "Size")
  fixture.variantIds = variants.map(variant => variant.id)
  fixture.priceIds = variants.map(variant => variant.prices[0].id)
  fixture.optionId = option.id
  creation.record.createdIds = [product.id, ...fixture.variantIds, ...fixture.priceIds,
    option.id, ...option.values.map(value => value.id)]
  for (const variant of variants) {
    const response = await fetch(`${baseUrl}/admin/inventory-items?sku=${variant.sku}`, { headers })
    if (!response.ok) throw new Error(`Inventory readback failed: ${response.status} ${await response.text()}`)
    const { inventory_items: [item] } = await response.json()
    fixture.inventoryItemIds.push(item.id)
    creation.record.createdIds.push(item.id)
    let level = item.location_levels.find(level => level.location_id === location.id)
    if (!level) {
      const levels = await measure("fixture.inventory.levels", fixture.inventoryItemIds.length,
        () => fetch(`${baseUrl}/admin/inventory-items/${item.id}/location-levels/batch`, {
          method: "POST", headers,
          body: JSON.stringify({ create: [{ location_id: location.id, stocked_quantity: 10 }] }),
        }), [item.id])
      level = levels.data.created[0]
      levels.record.createdIds = [level.id]
      levels.record.expectedIds.push(...levels.record.createdIds)
    } else {
      creation.record.createdIds.push(level.id)
    }
    fixture.levelIds.push(level.id)
  }
  creation.record.expectedIds.push(...creation.record.createdIds)
  for (let iteration = 1; iteration <= 5; iteration++) {
    await measure("product.update", iteration, () => fetch(`${baseUrl}/admin/products/${product.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ description: `g4 probe ${iteration}` }),
    }), [product.id])
  }
  const variantUrl = `${baseUrl}/admin/products/${product.id}/variants/${fixture.variantIds[0]}`
  for (let iteration = 1; iteration <= 5; iteration++) {
    await measure("variant.update", iteration, () => fetch(variantUrl, {
      method: "POST", headers, body: JSON.stringify({ title: `S ${iteration}` }),
    }), [fixture.variantIds[0]])
  }
  for (let iteration = 1; iteration <= 5; iteration++) {
    await measure("variant.prices", iteration, () => fetch(variantUrl, {
      method: "POST", headers,
      body: JSON.stringify({ prices: [{ id: fixture.priceIds[0], currency_code: region.currency_code, amount: 10 + iteration }] }),
    }), [fixture.variantIds[0], fixture.priceIds[0]])
  }
  for (let iteration = 1; iteration <= 5; iteration++) {
    await measure("inventory.level", iteration,
      () => fetch(`${baseUrl}/admin/inventory-items/${fixture.inventoryItemIds[0]}/location-levels/${location.id}`, {
        method: "POST", headers, body: JSON.stringify({ stocked_quantity: 10 + iteration }),
      }), [fixture.levelIds[0], fixture.inventoryItemIds[0]])
  }
  for (let iteration = 1; iteration <= 3; iteration++) {
    await measure("inventory.batch", iteration, () => fetch(`${baseUrl}/admin/inventory-items/location-levels/batch`, {
      method: "POST", headers,
      body: JSON.stringify({ update: fixture.inventoryItemIds.map(inventory_item_id => ({
        inventory_item_id, location_id: location.id, stocked_quantity: 20 + iteration,
      })) }),
    }), [...fixture.levelIds, ...fixture.inventoryItemIds])
  }
  const optionUrl = `${baseUrl}/admin/product-options/${option.id}`
  for (let iteration = 1; iteration <= 3; iteration++) {
    const values = option.values.map(value => value.value)
    const addition = await measure("option.value.add", iteration, () => fetch(optionUrl, {
      method: "POST", headers, body: JSON.stringify({ values: [...values, `X${iteration}`] }),
    }), [option.id, product.id])
    const response = await fetch(`${optionUrl}?fields=*values`, { headers })
    if (!response.ok) throw new Error(`Option readback failed: ${response.status} ${await response.text()}`)
    const { product_option } = await response.json()
    const valueId = product_option.values.find(value => value.value === `X${iteration}`).id
    addition.record.createdIds = [valueId]
    addition.record.expectedIds.push(...addition.record.createdIds)
    await measure("option.value.remove", iteration, () => fetch(optionUrl, {
      method: "POST", headers, body: JSON.stringify({ values }),
    }), [option.id, product.id, valueId])
  }
  for (let iteration = 1; iteration <= 3; iteration++) {
    for (const action of ["add", "remove"]) {
      await measure(`link.channel.${action}`, iteration,
        () => fetch(`${baseUrl}/admin/sales-channels/${otherChannel.id}/products`, {
          method: "POST", headers, body: JSON.stringify({ [action]: [product.id] }),
        }), [product.id])
    }
  }
  for (let iteration = 1; iteration <= 3; iteration++) {
    const channels = iteration % 2 ? [defaultChannel, otherChannel] : [defaultChannel]
    await measure("product.channels.replace", iteration, () => fetch(`${baseUrl}/admin/products/${product.id}`, {
      method: "POST", headers, body: JSON.stringify({ sales_channels: channels.map(({ id }) => ({ id })) }),
    }), [product.id])
  }
  const listCreation = await measure("price-list.create", 1, () => fetch(`${baseUrl}/admin/price-lists`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "G4 list", description: "G4 list", status: "active", type: "sale",
      prices: fixture.variantIds.flatMap(variant_id => [1, 2, 3].map(min_quantity => ({
        variant_id, min_quantity, currency_code: region.currency_code, amount: 8,
      }))),
    }),
  }), [])
  const listId = listCreation.data.price_list.id
  const pricesResponse = await fetch(`${baseUrl}/admin/price-lists/${listId}/prices?limit=500`, { headers })
  if (!pricesResponse.ok) throw new Error(`Price readback failed: ${pricesResponse.status} ${await pricesResponse.text()}`)
  let { prices: listPrices } = await pricesResponse.json()
  listCreation.record.createdIds = [listId, ...listPrices.map(price => price.id)]
  listCreation.record.expectedIds.push(...listCreation.record.createdIds)
  for (let iteration = 1; iteration <= 3; iteration++) {
    const updated = listPrices.slice(0, 3)
    const deletedId = listPrices[3].id
    const batch = await measure("price-list.batch", iteration,
      () => fetch(`${baseUrl}/admin/price-lists/${listId}/prices/batch`, {
        method: "POST", headers,
        body: JSON.stringify({
          create: [0, 1].map(index => ({ variant_id: fixture.variantIds[index],
            min_quantity: 4 + (iteration - 1) * 2 + index, currency_code: region.currency_code, amount: 7,
          })),
          update: updated.map(price => ({ id: price.id, variant_id: price.price_set.variant.id, amount: 8 + iteration })),
          delete: [deletedId],
        }),
      }), [...updated.map(price => price.id), deletedId])
    batch.record.createdIds = batch.data.created.map(price => price.id)
    batch.record.expectedIds.push(...batch.record.createdIds)
    listPrices = [...listPrices.filter(price => price.id !== deletedId), ...batch.data.created]
  }
  for (let iteration = 1; iteration <= 3; iteration++) {
    await measure("price-list.update", iteration, () => fetch(`${baseUrl}/admin/price-lists/${listId}`, {
      method: "POST", headers,
      body: JSON.stringify({ title: `G4 list ${iteration}`,
        starts_at: new Date(startedAt + iteration * 86400000).toISOString(),
        ends_at: new Date(startedAt + (iteration + 1) * 86400000).toISOString(),
      }),
    }), [listId])
  }
  const burst = await measure("price-list.burst.create", 1, () => fetch(`${baseUrl}/admin/price-lists`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "G4 burst", description: "G4 burst", status: "active", type: "sale",
      prices: Array.from({ length: 500 }, (_, index) => ({ variant_id: fixture.variantIds[index % 3],
        min_quantity: index + 1, currency_code: region.currency_code, amount: 6,
      })),
    }),
  }), [])
  const burstId = burst.data.price_list.id
  burst.record.createdIds = [burstId]
  burst.record.expectedIds.push(burstId)
  const burstResponse = await fetch(`${baseUrl}/admin/price-lists/${burstId}/prices?limit=500`, { headers })
  if (!burstResponse.ok) throw new Error(`Burst readback failed: ${burstResponse.status} ${await burstResponse.text()}`)
  const { prices: burstPrices } = await burstResponse.json()
  await measure("price-list.burst.update", 1, () => fetch(`${baseUrl}/admin/price-lists/${burstId}/prices/batch`, {
    method: "POST", headers,
    body: JSON.stringify({ update: burstPrices.map(price => ({
      id: price.id, variant_id: price.price_set.variant.id, amount: 7,
    })) }),
  }), [burstId])
  const directEnv = { ...process.env, G4_DIRECT_IDS: JSON.stringify({
    priceId: fixture.priceIds[1], levelId: fixture.levelIds[1], inventoryItemId: fixture.inventoryItemIds[1],
    locationId: fixture.locationId, variantId: fixture.variantIds[1],
  }) }
  // Only the server's subscriber may record delivery, including on the local bus.
  delete directEnv.G4_EVENT_PROBE_FILE
  await measure("direct.module.writes", 1, () => new Promise((resolve, reject) => {
    const child = spawn("npx", ["medusa", "exec", "./src/scripts/g4-direct-writes.ts"], {
      cwd: new URL("../../../apps/backend/", import.meta.url), env: directEnv, stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({
      exitedAt: Date.now(), status: code, ok: code === 0,
      text: async () => JSON.stringify({ code, signal }),
    }))
  }), [fixture.priceIds[1], fixture.levelIds[1], fixture.variantIds[1]])
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(resultsFile, JSON.stringify({ bus, startedAt, records, fixture }, null, 2) + "\n")
}
