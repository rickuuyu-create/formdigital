# Bundled offline OCR runtime

These files allow the browser OCR fallback to run from the Formdigital origin
without contacting a CDN or a paid API.

- `worker.min.js`: `tesseract.js` 7.0.0 from the installed package.
- `tesseract-core-lstm.wasm.js`: `tesseract.js-core` 7.0.0 from the installed package.
- `tessdata/*.traineddata.gz`: Apache-2.0 `tesseract-ocr/tessdata_fast`, pinned at revision `87416418657359cb625c412a48b6e1d6d41c29bd`.
- The corresponding license texts are stored beside the runtime files.

Pinned SHA-256 checksums:

```text
576B7DF7E3393E137E51849357C9ADB53FE7AC1BB69BFA06CF3D61520F182C6D  worker.min.js
EEF5F8B2F8E20E150680B20ADAEC4A60BABAFEE3ADBE8A94583C81FEE46E8680  tesseract-core-lstm.wasm.js
9BF11F95058D9DBFFB389E1D20DA36D8323E69FAAAABDF6D057513C3105590C8  tessdata/eng.traineddata.gz
B89E59F3B41D8A2467A79F14D6D7310360CE1F2048605B0B2914E5AC17BB12A7  tessdata/chi_tra.traineddata.gz
3A8FA873833E14B940F02B7DA65D1300FC09CC57C99BFE1FC55C1BA108C482B5  tessdata/chi_sim.traineddata.gz
```
