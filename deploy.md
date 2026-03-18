# Deploying MCP Tool Explorer

## Prerequisites

```powershell
npm install -g @vscode/vsce
```

---

## 1. Build

```powershell
cd c:\mcp\mcp-explorer
npm run build
```

---

## 2. Package as `.vsix`

```powershell
npm run package
```

Produces `mcp-tool-explorer-<version>.vsix` in the project root.

---

## 3. Install locally

**Via VS Code UI:**
1. Open VS Code
2. Extensions panel (`Ctrl+Shift+X`)
3. Click `...` (top-right) → **Install from VSIX…**
4. Select the `.vsix` file

**Via command line:**
```powershell
code --install-extension mcp-tool-explorer-1.0.0.vsix
```

---

## 4. Publish to VS Code Marketplace (optional)

### 4a. Create a publisher
- Visit https://marketplace.visualstudio.com/manage
- Sign in with a Microsoft account and create a publisher ID
- Update `package.json`:
  ```json
  "publisher": "your-publisher-id"
  ```

### 4b. Create a Personal Access Token
- Go to https://dev.azure.com
- User Settings → Personal Access Tokens → New Token
- Scope: **Marketplace → Manage**
- Copy the token

### 4c. Login and publish
```powershell
vsce login your-publisher-id
# paste your PAT when prompted

vsce publish
```

### 4d. Bump the version for updates
```powershell
vsce publish patch   # 0.1.0 → 0.1.1
vsce publish minor   # 0.1.0 → 0.2.0
vsce publish major   # 0.1.0 → 1.0.0
```

---

## Release checklist

- [ ] `npm run build` completes with no errors
- [ ] `npm run compile-check` passes
- [ ] Version updated in `package.json`
- [ ] Tested with F5 in Extension Development Host
- [ ] `.vsix` installed and smoke-tested in a clean VS Code window
