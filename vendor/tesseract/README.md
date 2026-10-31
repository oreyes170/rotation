# Text reader for screenshots

Used by "Read screenshots" in the item editor, loaded only when that's tapped, and cached by the service worker for offline use.

- `tesseract.min.js`, `worker.min.js`: [tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 (Apache-2.0, see LICENSE)
- `tesseract-core-*-lstm.wasm.js`: [tesseract.js-core](https://github.com/naptha/tesseract.js-core) 5.1.1 (Apache-2.0); the browser picks the SIMD build when it can
- `eng.traineddata.gz`: English LSTM model (`4.0.0_best_int`) from [@tesseract.js-data/eng](https://www.npmjs.com/package/@tesseract.js-data/eng) 1.0.0, from [tessdata](https://github.com/tesseract-ocr/tessdata_best) (Apache-2.0)
