#!/bin/bash

# Setup Script for Git Productivity Tools
# Run this script to install all git productivity tools

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${CYAN}Setting up Git Productivity Tools...${NC}"
echo ""

# 1. Configure git hooks
echo -e "${YELLOW}1. Configuring git hooks...${NC}"
cd "$PROJECT_DIR"
git config core.hooksPath .githooks
echo -e "   ${GREEN}✅ Git hooks configured${NC}"

# 2. Make scripts executable
echo -e "${YELLOW}2. Making scripts executable...${NC}"
chmod +x "$SCRIPT_DIR"/*.sh
echo -e "   ${GREEN}✅ Scripts are executable${NC}"

# 3. Add aliases to shell config
echo -e "${YELLOW}3. Setting up shell aliases...${NC}"

# Detect shell config file
if [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
else
    SHELL_RC="$HOME/.bash_profile"
fi

# Check if aliases already exist
if ! grep -q "# Private Logger Git Tools" "$SHELL_RC" 2>/dev/null; then
    cat >> "$SHELL_RC" << EOF

# Private Logger Git Tools
alias qc='$SCRIPT_DIR/quick-commit.sh'
alias gs='$SCRIPT_DIR/git-stats.sh'
alias gstats='$SCRIPT_DIR/git-stats.sh'
EOF
    echo -e "   ${GREEN}✅ Aliases added to $SHELL_RC${NC}"
    echo -e "   ${YELLOW}   Run 'source $SHELL_RC' to activate aliases${NC}"
else
    echo -e "   ${GREEN}✅ Aliases already configured${NC}"
fi

# 4. Install commit reminder (optional)
echo ""
echo -e "${YELLOW}4. Commit Reminder Setup (Optional)${NC}"
echo "   To receive notifications 4 times daily (10am, 2pm, 6pm, 9pm):"
echo ""
echo "   cp $SCRIPT_DIR/com.privatelogger.commitreminder.plist ~/Library/LaunchAgents/"
echo "   launchctl load ~/Library/LaunchAgents/com.privatelogger.commitreminder.plist"
echo ""
read -p "   Install commit reminder now? (y/N): " install_reminder

if [[ "$install_reminder" =~ ^[Yy]$ ]]; then
    mkdir -p ~/Library/LaunchAgents
    cp "$SCRIPT_DIR/com.privatelogger.commitreminder.plist" ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.privatelogger.commitreminder.plist 2>/dev/null || true
    echo -e "   ${GREEN}✅ Commit reminder installed${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Available commands (after sourcing shell config):"
echo "  qc         - Quick commit (interactive)"
echo "  gs/gstats  - Show git statistics"
echo ""
echo "Or run directly:"
echo "  ./scripts/quick-commit.sh"
echo "  ./scripts/git-stats.sh"
echo ""
