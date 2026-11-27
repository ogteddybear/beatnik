# Third-party notices

## ICY metadata dependencies

Live radio metadata uses these unmodified runtime libraries:

| Package | Version | Copyright | License |
| --- | --- | --- | --- |
| icecast-metadata-js | 1.2.10 | Ethan Halsall and contributors | LGPL-3.0-or-later |
| codec-parser (transitive) | 2.5.0 | Ethan Halsall and contributors | LGPL-3.0-or-later |

Sources:

- https://github.com/eshaz/icecast-metadata-js
- https://registry.npmjs.org/icecast-metadata-js/-/icecast-metadata-js-1.2.10.tgz
- https://github.com/eshaz/codec-parser
- https://registry.npmjs.org/codec-parser/-/codec-parser-2.5.0.tgz

The packages' original license and copyright notices are retained in their
`node_modules` directories, including in the production image. The application
loads `icecast-metadata-js` as a separate runtime dependency rather than bundling
it into the application. These libraries remain replaceable and unmodified.

License text: https://www.gnu.org/licenses/lgpl-3.0.html

This notice does not change the application's own license. Other dependencies
retain their respective licenses and notices.
