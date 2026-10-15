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

Sales chat: **Noni Sales AI** runs on Gemini through Firebase AI Logic
(Gemini Developer API, free tier, `gemini-flash-lite-latest` with
`gemini-flash-latest` as fallback). No Gemini key is in this repo; Firebase
holds it. Its name, rules and catalogue are set in `noniSystem` in
`shop/index.html`. Noni can also change the screen through Gemini function
calling (`noniTools` / `runNoniTool`): open a product in assembled, exploded or
X-ray view with a spec highlighted, compare 2-3 products, open an enterprise
demo module, add to cart, open a page, or pre-fill a quote. It cannot place
orders; the customer still submits checkout.

3D models (`shop/g3d.js`, `shop/admin3d.js`, admin tab "3D models"): upload a
product photo and generate `.glb` models with three free Hugging Face Spaces in
parallel, straight from the browser (no backend): Stable Fast 3D (successor of
TripoSR, whose Space is broken), InstantMesh and Hunyuan3D-2 (falls back to an
untextured shape when its texture step fails). Each Space removes the
background itself. "Use This Model" stores the chosen `.glb` in Firestore as
~900 KB chunks (`productModels/{pid}/chunks`, max 15 MB; the free plan has no
file storage) and sets `products/{pid}.model3d`; the shop loads it into the
product viewer and caches it in the browser. Free GPU time is limited per
person per day; an optional Hugging Face token (saved only in the admin's
browser) gives more.

Photo models (`shop/photo3d.js`, admin tab "3D models", first card): for flat
products (phones, tablets, TVs) the admin builds the model from real photos
instead of AI. It starts with the product's 360° photos (front and back
needed, sides optional), trims the background, and lays each photo on a
rounded slab sized from the width you enter (thickness from a side photo).
The photos are unlit so their colours match the product. Built in the
browser in seconds, about 100–150 KB, no GPU limits; saved like the AI
models (`engine: 'photo'`).

Payments are manual: customers see the till/paybill number from
`settings/shop` and the admin marks orders paid after checking M-Pesa.

## Deploy

    firebase deploy --project nonix-technologies --account kimutaibettdesktop@gmail.com

This deploys hosting, Firestore rules and the email/password sign-in setting
(`auth` in `firebase.json`).
