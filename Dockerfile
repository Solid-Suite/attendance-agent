# Agent chấm công — chạy trong mạng công ty khách hàng.
#
# Build từ chính thư mục này (không cần cả monorepo):
#   docker build -t solid-attendance-agent .
#
# Ảnh cố tình gọn: chỉ Node + `pg`.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# Watermark phải nằm trên volume bền. Mất file này thì agent quét lại từ đầu —
# không sai dữ liệu (ERP chống trùng) nhưng tốn một vòng đọc lớn.
VOLUME ["/var/lib/solid-attendance-agent"]
ENV STATE_PATH=/var/lib/solid-attendance-agent/state.json

# Chạy bằng user thường, không cần quyền root.
USER node

CMD ["node", "dist/index.js", "/app/config.json"]
