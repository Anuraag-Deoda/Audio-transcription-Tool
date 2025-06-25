#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Arguments: Environment (staging or production) and Component (client/server/all)
ENVIRONMENT=$1
COMPONENT=${2:-"all"}  # Default to "all" if not specified

# Define the project directory
PROJECT_DIR="/home/ec2-user/MITR-AI"

# Function to log messages with timestamps
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting deployment of $COMPONENT to $ENVIRONMENT environment"

# Navigate to the project directory
cd $PROJECT_DIR

# Ensure necessary directories exist
mkdir -p /home/ec2-user/Games_New /home/ec2-user/projects /home/ec2-user/uploads

deploy_client() {
    log "Building and deploying the client application"
    cd $PROJECT_DIR/client
    docker stop chamberlain-client-container || true
    docker rm chamberlain-client-container || true
    docker rmi chamberlain-client-app || true
    docker system prune -f --filter "label=component=client"
    docker build -t chamberlain-client-app --label component=client .
    docker run -d -p 3001:3001 --name chamberlain-client-container chamberlain-client-app
}

deploy_server() {
    log "Building and deploying the server application"
    cd $PROJECT_DIR/server
    docker stop flask-container || true
    docker rm flask-container || true
    docker rmi my-server-app || true
    docker system prune -f --filter "label=component=server"
    docker build -t my-server-app --label component=server .
    docker run -d -p 5000:5000 --name flask-container \
        -v /home/ec2-user/Games_New:/app/build \
        -v /home/ec2-user/projects:/app/projects \
        -v /home/ec2-user/uploads:/app/upload \
        my-server-app
}

# Deploy based on component parameter
case $COMPONENT in
    "client")
        deploy_client
        ;;
    "server")
        deploy_server
        ;;
    "all")
        deploy_client
        deploy_server
        ;;
    *)
        log "Invalid component specified. Use 'client', 'server', or 'all'"
        exit 1
        ;;
esac

log "Deployment of $COMPONENT completed successfully"
