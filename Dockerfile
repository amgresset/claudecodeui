FROM node:20-slim

# Install git, python, and build tools (needed for node-pty and other native modules)
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (this uses your Max subscription)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Build the frontend
RUN npm run build

# Fix ownership for node user
RUN chown -R node:node /app

# Use node user (UID 1000) for file permissions compatibility
USER node

# Expose port
EXPOSE 3010

ENV PORT=3010

CMD ["node", "server/index.js"]
