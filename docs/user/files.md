# Files

The Files pane shows the files and folders in the current project. Files excluded by Git are hidden
by default so generated dependencies, build output, and local caches do not overwhelm the tree.

In a Git repository, the tree colors uncommitted files and labels them as added (`A`), modified
(`M`), renamed (`R`), or untracked (`U`). A marker on a folder means it contains one or more
changed files. The status updates when an agent turn finishes and when you refresh the Files pane.
Web, desktop, and mobile use the same working-tree status reported by the connected environment.

Use **Show ignored files** in the Files toolbar to include paths matched by `.gitignore`,
`.git/info/exclude`, or Git's configured global excludes. Ignored text files can be opened and read
like any other project file. Folders load as you open them, so even very large ignored dependency
or cache directories do not prevent later paths from appearing. Turn the option off to return to
the filtered tree.

Ignored files are also available when searching for a file from **Open file** or typing `@` in the
composer. They stay out of the default Files tree, but appear when their path matches the search.

Drag a file from the Files tree, or drag the label of an open file tab, onto the composer to add it
as file context.

On web and desktop, when the connected server runs on macOS or Linux, drag one file onto a folder
in the Files tree to move it into that folder. Drop it at the tree root to move it to the project
root. Moving folders and moving several selected files at once are not supported yet. If the
destination already contains an entry with the same name, T3 Code rejects the move and does not
overwrite it.

Open file tabs remember their source, rendered Markdown, or image scroll position for the current
session when you switch tabs or chats and return.

On web and desktop, rendered Markdown previews display fenced `mermaid` blocks as diagrams. Use the
diagram toolbar to switch between the diagram and its source or to copy the original Mermaid code.
If a diagram is invalid, the preview keeps the source visible so the rest of the document remains
readable. Mobile currently displays Mermaid fences as code.

Right-click a file or folder and choose **Delete** to remove it from the project. Deleting a folder
also deletes everything inside it. T3 Code asks for confirmation because deleted workspace entries
are not moved to the system trash.

## Comment on a file

In source view, select one or more lines to add a comment. In a rendered Markdown preview, hover a
paragraph, heading, list item, quote, code block, or table and use the comment button in the left
margin. Comments from either view are attached to the same source lines and added to the composer as
review context. Removing a comment from the file or composer removes it from both source and rendered
views.
