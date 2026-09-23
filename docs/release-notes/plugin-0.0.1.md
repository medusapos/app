# Medusa POS plugin 0.0.1

First plugin tarball for the hosted MedusaPOS MVP. Requires Medusa 2.21.0
(`@medusajs/framework` and `@medusajs/medusa` peer dependencies).

- Adds `POST /tally/v1/commands` for authenticated admin POS order ingestion.
- Adds the command ledger module to record outcomes and deduplicate retries.
- Adds the order workflow: create, mark paid with the POS total, fulfill and
  complete orders, deducting stock and reporting offline oversell warnings.
  Cash and external card-terminal payments are recorded; no money is moved.

Install in your Medusa store:

```sh
npm install https://github.com/medusapos/app/releases/download/plugin-v0.0.1/medusapos-medusa-plugin-0.0.1.tgz
```

Register `@medusapos/medusa-plugin` in `medusa-config.ts`, then run:

```sh
npx medusa db:migrate
```

Restart the backend. Follow the [tester quick-start](../QUICKSTART.md) for
plugin registration, CORS, stock, shipping, tax and signing in to the hosted app.
