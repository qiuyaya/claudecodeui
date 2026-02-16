#!/bin/bash
# Stop and remove Claude Code WebUI systemd service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Stopping Claude Code WebUI Service ===${NC}\n"

SERVICE_FILE="${HOME}/.config/systemd/user/claude-webui.service"

# Check if service exists
if [ ! -f "${SERVICE_FILE}" ]; then
    echo -e "${RED}Service file not found: ${SERVICE_FILE}${NC}"
    exit 1
fi

# Stop the service
echo -e "Stopping service..."
systemctl --user stop claude-webui.service || true

# Disable the service
echo -e "Disabling service..."
systemctl --user disable claude-webui.service || true

# Remove the service file
echo -e "Removing service file..."
rm -f "${SERVICE_FILE}"

# Reload systemd daemon
echo -e "Reloading systemd daemon..."
systemctl --user daemon-reload

echo -e "\n${GREEN}Service stopped and removed successfully${NC}\n"
