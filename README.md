# NonixTech site

Static marketing site for NonixTech, live at https://nonixtech.co.ke
(Firebase Hosting, project `nonix-technologies`, owned by
kimutaibettdesktop@gmail.com).

The main page (`index.html`), its images and the Google verification file were
downloaded from the live nonixtech.co.ke on 2026-10-15; the original source was
not found anywhere else. An older copy of the site also runs on
https://nonixtech.web.app (project `nonixtech`); it is not the live domain.

## Shop (`/shop/`)

- `shop/index.html`: the Nonix Shop storefront (3D product viewer, cart,
  M-Pesa checkout, enterprise quote builder). Built from the NEXUS 3D Claude
  Design export and rebranded. Products and settings load from Firestore; the
  built-in sample products are only a fallback.
- `shop/admin.html` (served as `/shop/admin`): admin page for orders, quote requests, products/photos and
  M-Pesa settings. Sign-in is email/password; an account is an admin only if
  a document `admins/{uid}` exists (create it from the Firebase console or
  with the CLI; the rules block it from the browser).
- `firestore.rules`: anyone can read products and place orders or quote
  requests; only admins can read orders/quotes or change the catalogue.

Payments are manual: customers see the till/paybill number from
`settings/shop` and the admin marks orders paid after checking M-Pesa.

## Deploy

    firebase deploy --project nonix-technologies --account kimutaibettdesktop@gmail.com

This deploys hosting, Firestore rules and the email/password sign-in setting
(`auth` in `firebase.json`).
