#!/bin/bash -eu

npm ci
npm run build

compile_javascript_fuzzer mongodb-query-optimizer fuzz_index.cjs
