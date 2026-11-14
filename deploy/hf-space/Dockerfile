# Blueline demo for a Hugging Face Docker Space (free "CPU basic" hardware).
# Runs fully local: no cloud model, image plans answered by the ONNX detectors in models/.
FROM node:22-bookworm-slim

# Spaces run the container as uid 1000, which is the image's "node" user.
USER node
WORKDIR /home/node/space

COPY --chown=node app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund

COPY --chown=node app/ app/
RUN cd app && npm run build

COPY --chown=node models/ models/
COPY --chown=node dataset/ dataset/

ENV HOST=0.0.0.0 \
    PORT=7860 \
    VISION_PROVIDER=none \
    DETECTOR=onnx \
    RASTER_DETECTOR_TARGETS=all \
    RASTER_SYMBOL_VOTE=off

EXPOSE 7860
WORKDIR /home/node/space/app
CMD ["npx", "tsx", "server/src/server.ts"]
