#!/bin/bash
# Deploy script for aimax-viewer extension
# Compiles, bumps version, packages, and installs

set -e

cd "$(dirname "$0")"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${CYAN}[1/4]${NC} Compiling TypeScript..."
npm run compile

echo -e "${CYAN}[2/4]${NC} Bumping patch version..."
# Extract current version and bump patch
CURRENT=$(node -p "require('./package.json').version")
NEW=$(node -p "const v='$CURRENT'.split('.'); v[2]=parseInt(v[2])+1; v.join('.')")
# Update package.json
node -e "const fs=require('fs'); const p=require('./package.json'); p.version='$NEW'; fs.writeFileSync('./package.json', JSON.stringify(p, null, 2)+'\n')"
echo "   $CURRENT → $NEW"

echo -e "${CYAN}[3/4]${NC} Packaging VSIX..."
npx vsce package --allow-missing-repository --skip-license 2>&1 | grep -v "WARNING"

echo -e "${CYAN}[4/4]${NC} Installing extension..."
code --install-extension "aimax-viewer-${NEW}.vsix" --force

# Cleanup old vsix files
rm -f aimax-viewer-*.vsix 2>/dev/null || true

echo ""
echo -e "${GREEN}✓ Deployed v${NEW}${NC}"
echo -e "  Run: ${CYAN}Cmd+Shift+P → Developer: Reload Window${NC}"
