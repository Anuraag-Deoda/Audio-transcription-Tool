# Dockerfile
FROM node:20

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-venv python3-pip ffmpeg

# Set work directory
WORKDIR /app

# Copy files
COPY . .

# Python venv setup
RUN python3 -m venv venv && \
    ./venv/bin/pip install --upgrade pip && \
    ./venv/bin/pip install openai-whisper torch

# Node.js dependencies
RUN npm install

# Create uploads dir
RUN mkdir -p uploads

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]