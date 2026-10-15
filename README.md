# NonixTech site

Static marketing site for NonixTech, live at https://nonixtech.web.app
(Firebase Hosting, project `nonixtech`).

The main page (`index.html`) was recovered from the live deployment on
2026-10-15; the original source was not found anywhere else.

## Shop (`/shop/`)

- `shop/index.html`: the Nonix Shop storefront (3D product viewer, cart,
  M-Pesa checkout, enterprise quote builder). Built from the NEXUS 3D Claude
  Design export and rebranded. Products and settings load from Firestore; the
  built-in sample products are only a fallback.
- `shop/admin.html`: admin page for orders, quote requests, products/photos and
  M-Pesa settings. Sign-in is email/password; an account is an admin only if
  a document `admins/{uid}` exists (create it from the Firebase console or
  with the CLI; the rules block it from the browser).
- `firestore.rules`: anyone can read products and place orders or quote
  requests; only admins can read orders/quotes or change the catalogue.

Payments are manual: customers see the till/paybill number from
`settings/shop` and the admin marks orders paid after checking M-Pesa.

## Deploy

    firebase deploy --only hosting,firestore:rules
