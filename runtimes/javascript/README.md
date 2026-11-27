# noodlegraph runtime for JavaScript

Checks and runs the graphs the noodlegraph editor draws, as the [spec](../../spec/SPEC.md) says.
Plain ES modules with no dependencies and no build step. It uses nothing of a page, so it runs in
a browser, in Node.js 18+ and wherever else JavaScript runs. See the [project README](../../README.md).

```
cd runtimes/javascript
npm test                                       # the tests, the shared test graphs included
```
