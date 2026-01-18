FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./
COPY tsconfig.json ./

# Install dependencies
RUN yarn install --frozen-lockfile --production && yarn global add tsx

# Copy source code and config
COPY src/ ./src/
COPY config/ ./config/

# Start the service
CMD ["tsx", "src/index.ts"]
