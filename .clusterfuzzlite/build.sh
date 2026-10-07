#!/bin/bash -eu

npm install
npm install --save-dev @jazzer.js/core
npm run build

compile_javascript_fuzzer mongodb-query-optimizer fuzz_index.cjs
