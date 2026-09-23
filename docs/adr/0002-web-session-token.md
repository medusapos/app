# 0002: Web session token

Status: Accepted
Date: 2026-09-23

## Context

The MVP is a hosted web POS signing in cross-origin to arbitrary testers'
Medusa backends. httpOnly cookies are not workable across those arbitrary
backend origins.

## Decision

The web session stores Medusa's emailpass JWT in localStorage, never the
password. Tokens live for about one day; the app refreshes inside six hours
of expiry, checking on mount and every five minutes.

Network errors and server failures never sign out. A 401 on refresh or a
product data request signs out. Plain HTTP is allowed only for loopback
and private network hosts; all other backends require HTTPS.

## Mitigations

A11 must ship a strict Content-Security-Policy with the hosted app to
mitigate script access to localStorage. The product cache is named per
backend and removed at sign-out to isolate stores' products.

## Native

The post-MVP native milestone moves the token to SecureStore. Until then,
native keeps it in memory only, acceptable because the MVP is the hosted
web app.
