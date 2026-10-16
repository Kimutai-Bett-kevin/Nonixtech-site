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

Phone photos (`shop/photo3d.js`, admin tab "3D models", first card): the
recommended way to show a phone. The admin picks a front and a back photo
(the product's 360° photos by default); the background is trimmed (only
background connected to the photo's edges, so white parts of the phone stay)
and the two JPEGs are saved in `productSkins/{pid}`, with `products/{pid}.skin`
pointing at them. The shop puts them on its built-in phone: rounded body,
front photo as the screen, back photo as the back cover, proportions from the
photos, frame in the phone's edge colour. Exploded and X-Ray still show the
board, chips, battery and camera with the spec labels. Saving photos removes
any AI model from the product (an AI model would be shown instead).
`/shop/?product=<id>` opens a product directly.

Find & Build 3D (`shop/findphotos.js`, first card in the 3D models tab): one
click from the product name to a finished 3D model. It searches Google Images
through [Serper](https://serper.dev) (free key, saved only in the admin's
browser), drops results named as a different variant (Pro Max, Ultra,
Plus…), and has Gemini (Firebase AI Logic, same quota as Noni) mark
straight-on front and back views and the best overall view of the exact
product in up to 24 results. Phones: the best front and back go straight
into Phone photos and the 3D phone is built and shown (if only one side is
found it's filled in and uploading the other builds it). Other shapes: the
best photo goes into the AI-engine card and the engines start; the admin
then picks the best model. Clicking another candidate rebuilds. Images are
fetched through the public `wsrv.nl` proxy, because other sites don't let
browsers read them.

Real 3D models (`shop/findmodel.js`): Find & Build 3D also searches
Sketchfab's downloadable models (search needs no key) at the same time,
keeps only licences that allow shop use (CC BY, BY-SA, BY-ND, CC0, Standard)
and names with every variant word searched for, and has Gemini check the
previews. With the admin's free Sketchfab API token (saved only in their
browser) the best one is downloaded as .glb, phones are stood upright with
the screen facing front (Gemini looks at both faces), textures are shrunk
to 1024 px JPEG, and it's saved like an AI model with `model3d.credit`
(name, author, licence, link), shown under the model in the shop as the
licences require. Up to three models are tried before falling back to the
photo methods. On phone models, Exploded moves front parts forwards and back
parts backwards and shows the built-in board, chips, battery and camera
inside with the spec labels; X-Ray makes the shell see-through. The empty
360° photo boxes (`productPhotos`) are filled with the found front, back and
side photos and with renders of the model from each side; photos already
there are kept.

Payments are manual: customers see the till/paybill number from
`settings/shop` and the admin marks orders paid after checking M-Pesa.

## Deploy

    firebase deploy --project nonix-technologies --account kimutaibettdesktop@gmail.com

This deploys hosting, Firestore rules and the email/password sign-in setting
(`auth` in `firebase.json`).
