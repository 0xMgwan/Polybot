FROM node:18-alpine

WORKDIR /app

# Copy all source files first (postinstall script needs them)
COPY . .

# Install all dependencies (including devDependencies for TypeScript build)
RUN npm install

# Build TypeScript
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev

# Start the bot
CMD ["npm", "start"]
