# Source Control Integrations

T3 Code connects to your Git hosting provider so you can create pull requests, review code, and manage repositories without leaving the app.

## Supported Providers

T3 Code works with the platforms your team already uses:

- **GitHub** – Pull requests, repository creation, and clone integration
- **GitLab** – Merge requests, repository publishing, and hosted clones
- **Bitbucket** – Pull request workflows (via API token authentication)
- **Azure DevOps** – Pull request support for Microsoft-hosted repositories

## What You Can Do

### Start Projects from Anywhere

**Clone repositories directly**

- Open the Command Palette (`Cmd/Ctrl + K`) → **Add Project**
- Choose **GitHub repository**, **GitLab repository**, **Bitbucket repository**, **Azure DevOps repository**, or paste any **Git URL**
- Enter the repository path (`owner/repo`, `group/project`, `workspace/repository`, or `project/repository`) or a full Git URL, pick a destination, and start coding

**Publish local projects to the cloud**

- Have a local Git repository without a remote?
- Use the **Publish Repository** action to create a new hosted repository (GitHub, GitLab, Bitbucket, or Azure DevOps), add it as your origin remote, and push, in one flow
- If the local repository has no commits yet, publishing creates the remote and wires it up but does not push. Make a commit, then push normally.

### Manage Code Reviews Without Context Switching

**Create pull requests while you work**

- Push a branch and create a pull request from the Git actions controls in the toolbar
- T3 Code can suggest titles and descriptions based on your commits
- Supports GitHub Pull Requests, GitLab Merge Requests, Bitbucket Pull Requests, and Azure DevOps Pull Requests

**Stay on top of open reviews**

- See if your current branch already has an open PR/MR
- Open several reviews from the **Pull requests** page as tabs in the right panel
- While working in a thread, open linked reviews in the same compact right-panel tabs without
  leaving the conversation
- Switch threads or right-panel tabs and return to the same place in a review, including its
  active section, commit scope, expanded files, loaded diff pages, and scroll position
- Open the review directly in your browser with one click
- Check out a teammate's branch to review code locally

**Review local changes completely**

Open the Diff panel and choose **Working tree** for uncommitted changes or **Branch changes** to
compare the current branch with its selected base. Files load progressively as you approach the end
of the diff, so a large change remains quick to open while every changed file stays reachable. The
additions and deletions in the header always describe the complete comparison, including files that
have not loaded yet.

Switching right-panel tabs preserves the pages and scroll position already reached. **Collapse all**
and **Expand all** also apply to files that load on later pages.

Loading another page does not mean the diff is incomplete. A partial-diff notice appears only when
an individual file cannot be shown inline, such as an unusually large or binary change. Other files
continue loading normally. When connected to an older T3 Code server, the app retains the former
bounded preview and says explicitly if that legacy preview was truncated.

### Know Your Setup at a Glance

The **Source Control settings** page shows you exactly what's connected:

- ✅ Which providers are authenticated and ready
- ⚠️ What's missing and how to fix it
- 👤 Which account is signed in (when available)

Run a quick **Rescan** after setting up a new machine or changing credentials.

### Choose Generated Worktree Branch Names

T3 Code gives a new worktree branch a descriptive name after its first message. Use **Settings →
Source Control → Worktree branch prefix** to choose the namespace for those generated names. For
example, `feature` produces `feature/fix-sidebar-resize`. Leave the field empty to produce
`fix-sidebar-resize` without a prefix, or reset it to restore the default `t3code` namespace.

The setting belongs to the connected environment, so it applies consistently when starting work
from web, desktop, or mobile. Existing branches are not renamed.

### Browse Commit History

Open **History** from the empty Right Panel or its **+** menu to browse the repository's commit
graph, subjects, authors, author dates, and commit IDs. It uses the branches, remote refs, and tags
already known by the Git repository on the server. Opening it does not fetch from a remote or change
the working tree.

Use **Fetch all** in the History header to fetch every configured Git remote and then reload the
graph. Fetching updates remote-tracking refs without changing the current branch, index, or working
tree. The adjacent reload button only rereads the repository state already available on the server.

Branch, remote-branch, and tag labels appear beside the subject on the commit each ref currently
points to. Rows stay on one line; when a commit has several refs, the remaining labels are grouped
behind a compact **+N** indicator and remain available in its tooltip.

The header shows the total number of commits in that public history. Commit rows load in pages as
you request older entries, so showing the total does not load every row at once.

Select a commit ID to copy its full SHA. The commit ID briefly changes to **Copied** after a
successful copy.

Use the diff button beside a commit ID to open that commit in its own Right Panel tab. Commit tabs
show metadata and the changes against the first parent, or against an empty tree for the first
commit in a repository. You can keep several commit tabs open and switch between them. Opening the
same commit again returns to its existing tab instead of creating a duplicate.

Commit diffs support stacked and split views, line wrapping, collapsible files, and expanding
unchanged context. Large patches are shown with a truncation notice, while binary or oversized file
contents remain unavailable for expansion.

History behaves like the other Right Panel tabs: select its tab to return to it, use the tab's close
control to remove it, and open **History** again from the empty state or **+** menu when needed. This
restores the loaded pages and scroll position for the current session when you switch tabs or chats
and return. This first version does not add a Command Palette action, keyboard shortcut, or desktop
menu item.

## Getting Started

### For GitHub (Recommended for most users)

1. Install the GitHub CLI on the machine running T3 Code:
   ```bash
   brew install gh
   ```
2. Sign in:
   ```bash
   gh auth login
   ```
3. Open **Settings → Source Control** in T3 Code and verify GitHub shows as authenticated

You can now clone, publish, and create pull requests.

### For GitLab

1. Install the GitLab CLI:
   ```bash
   brew install glab
   ```
2. Authenticate:
   ```bash
   glab auth login
   ```
3. Check **Settings → Source Control** to confirm the connection

### For Bitbucket

Bitbucket uses tokens instead of a CLI tool. Two options, both set as environment variables on the
machine running T3 Code.

Recommended, a Bitbucket access token:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or an Atlassian account email plus API token, with read/write access to pull requests and
repositories:

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

If both are set, the access token wins. Restart T3 Code and verify the connection in **Source
Control settings**.

### For Azure DevOps

1. Install Azure CLI:
   ```bash
   brew install azure-cli
   ```
2. Add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Sign in:
   ```bash
   az login
   ```

---

## Requirements & Troubleshooting

**Git is required** – T3 Code uses Git for all local operations. Ensure `git` is installed on your server.

**Server-side setup** – Authentication happens on the machine running T3 Code (the server), not your local browser. If you're using a hosted or team instance, your administrator may have already configured providers.

**Common issues:**

- **Provider shows "Not authenticated"** – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings
- **Bitbucket not connecting** – Double-check your environment variables are set in the correct shell profile and the server was restarted
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/)
