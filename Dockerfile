# VIGIL ships with zero npm dependencies, so the image installs nothing: the
# checked-out repository IS the artifact. Reproduce the committed evidence with
#
#   docker build -t vigil .
#   docker run --rm vigil
#
# or `docker compose run --rm reproduce`. The command re-derives the reference
# run bundle, the discrimination report and the rush calibration offline.
FROM node:24-slim
LABEL org.opencontainers.image.title="vigil-bench"
WORKDIR /app
COPY . .
ENV NO_COLOR=1
CMD ["node", "scripts/reproduce.mjs"]