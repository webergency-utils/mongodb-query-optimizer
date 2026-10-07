FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:2e218dedc1603f15e34cec784030789e06db1df8eb5356f0a8e27285619ac8c2
COPY . $SRC/mongodb-query-optimizer
WORKDIR $SRC/mongodb-query-optimizer
COPY .clusterfuzzlite/build.sh $SRC/build.sh
