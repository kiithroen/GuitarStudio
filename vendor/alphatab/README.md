# alphaTab vendor assets

Pinned package: `@coderline/alphatab` 1.8.4, the npm `latest` stable tag checked on 2026-10-18. The newer `1.9.0-alpha.1962` is a prerelease and was excluded.

Source: https://registry.npmjs.org/@coderline/alphatab/-/alphatab-1.8.4.tgz

Package homepage: https://alphatab.net/

Repository: https://github.com/CoderLine/alphaTab
Package license: MPL-2.0 (`LICENSE`). Bravura is licensed under SIL OFL 1.1 (`dist/font/Bravura-OFL.txt`). The Sonivox soundfont license is in `dist/soundfont/LICENSE`.

The npm tarball integrity is `sha512-VN5rfTZZWgA63Ny1aDKCp02k3Qm9CHhg4Q9AnK0kHm7G+fNDNZo36TeToPDFoJ6VpB9+AHcCrHwHFUP1tKqdsw==` (SHA-1 `4b6874b056f54a0271348f5f6ed8ee5d9b8dfc95`). `dist/alphaTab.min.js` is the UMD browser bundle and exports global `alphaTab`; its Node CommonJS export has the same API. The worker and audio-worklet modules import `alphaTab.core.mjs` from the same directory.

Included assets are the UMD runtime, ESM runtime used by worker/worklet, worker/worklet entry modules, Bravura WOFF2 font, Sonivox SF2 soundfont, and their required license files. No package manager tree, archive, source map, or unused platform asset is shipped.

The distributed assets retain their original bytes, including upstream whitespace. Git text conversion is disabled for these assets. Check application whitespace with `git diff --cached --check -- . ':(exclude)vendor/alphatab/dist/**' ':(exclude)vendor/alphatab/LICENSE'` and verify the vendor checksums below separately.

SHA-256 checksums:

```
de981130586154b6ce2cf91528b9291789192d62234d0d7e6e41d085b8e1d351  LICENSE
2d0335501b875453d52359de23cd9cebfcf71aed3d5739f1cf95117acfd52bec  dist/alphaTab.min.js
7330a805eab246bd329927e895ac46eb8eae1da4d27375c66e223c91dd1a5817  dist/alphaTab.core.mjs
4c5524f00cf733d04c80cf005f909a25e640bd70064256a91f94499af05e5b7b  dist/alphaTab.worker.min.mjs
4a7547759fb3c8b49f0fe246d1ece8402134c5bc337a12601bc847fa1ee2c153  dist/alphaTab.worklet.min.mjs
181e0e7c4889f9ad57dde0a11988fa61b941617aa499ecdb9dfd4713896c2b19  dist/font/Bravura.woff2
c24929be7028026a65ee8894da1e3c36d2a4ccce0548d9ba8ba64509f46319ee  dist/font/Bravura-OFL.txt
4978cf37e7164206f2d22dc4fdf4020ffe040787210bf781e31bdc79961f59ef  dist/soundfont/sonivox.sf2
57d801cd718614be838c71f35cf3dcbf5c011fa20130c194a447483dfa2771c5  dist/soundfont/LICENSE
```
