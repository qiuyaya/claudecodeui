#!/bin/bash
# Deploy Claude Code WebUI as a systemd user service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Claude Code WebUI Systemd Deployment ===${NC}\n"

# Get the absolute path of the project directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo -e "Project directory: ${YELLOW}${PROJECT_DIR}${NC}"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    exit 1
fi

NODE_PATH=$(which node)
echo -e "Node.js path: ${YELLOW}${NODE_PATH}${NC}"
echo -e "Node.js version: ${YELLOW}$(node --version)${NC}\n"

# Check if .env exists
if [ ! -f "${PROJECT_DIR}/.env" ]; then
    echo -e "${YELLOW}Warning: .env file not found. Creating from .env.example...${NC}"
    if [ -f "${PROJECT_DIR}/.env.example" ]; then
        cp "${PROJECT_DIR}/.env.example" "${PROJECT_DIR}/.env"
        echo -e "${GREEN}.env file created. Please edit it with your configuration.${NC}\n"
    else
        echo -e "${RED}Error: .env.example not found${NC}"
        exit 1
    fi
fi

# Read PORT from .env
PORT=$(grep "^PORT=" "${PROJECT_DIR}/.env" | cut -d '=' -f2 | tr -d ' ')
if [ -z "$PORT" ]; then
    PORT=3001
    echo -e "${YELLOW}PORT not set in .env, using default: ${PORT}${NC}"
else
    echo -e "Service will run on port: ${YELLOW}${PORT}${NC}"
fi

# Create systemd user directory if it doesn't exist
SYSTEMD_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SYSTEMD_DIR}"

# Create the service file
SERVICE_FILE="${SYSTEMD_DIR}/claude-webui.service"
echo -e "\nCreating systemd service file: ${YELLOW}${SERVICE_FILE}${NC}"

cat > "${SERVICE_FILE}" << EOF
[Unit]
Description=Claude Code WebUI
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_PATH} server/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${PORT}

[Install]
WantedBy=default.target
EOF

echo -e "${GREEN}Service file created successfully${NC}\n"

# Reload systemd daemon
echo -e "Reloading systemd daemon..."
systemctl --user daemon-reload

# Enable the service
echo -e "Enabling service to start on boot..."
systemctl --user enable claude-webui.service

# Enable linger so service persists after logout
echo -e "Enabling linger for user..."
loginctl enable-linger

# Start the service
echo -e "Starting service..."
systemctl --user start claude-webui.service

# Wait a moment for service to start
sleep 2

# Check service status
echo -e "\n${GREEN}=== Service Status ===${NC}"
systemctl --user status claude-webui.service --no-pager -l

echo -e "\n${GREEN}=== Deployment Complete ===${NC}"
echo -e "\nService management commands:"
echo -e "  ${YELLOW}systemctl --user status claude-webui${NC}   - Check status"
echo -e "  ${YELLOW}systemctl --user restart claude-webui${NC}  - Restart service"
echo -e "  ${YELLOW}systemctl --user stop claude-webui${NC}     - Stop service"
echo -e "  ${YELLOW}systemctl --user start claude-webui${NC}    - Start service"
echo -e "  ${YELLOW}journalctl --user -u claude-webui -f${NC}   - View logs"
echo -e "\nAccess the application at: ${GREEN}http://localhost:${PORT}${NC}\n"
