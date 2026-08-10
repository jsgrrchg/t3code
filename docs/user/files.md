# Files

The Files pane shows the files and folders in the current project. Files excluded by Git are hidden
by default so generated dependencies, build output, and local caches do not overwhelm the tree.

Use **Show ignored files** in the Files toolbar to include paths matched by `.gitignore`,
`.git/info/exclude`, or Git's configured global excludes. Ignored text files can be opened and read
like any other project file. Turn the option off to return to the filtered tree.

Ignored files are also available when searching for a file from **Open file** or typing `@` in the
composer. They stay out of the default Files tree, but appear when their path matches the search.

## Comment on a file

In source view, select one or more lines to add a comment. In a rendered Markdown preview, hover a
paragraph, heading, list item, quote, code block, or table and use the comment button in the left
margin. Comments from either view are attached to the same source lines and added to the composer as
review context. Removing a comment from the file or composer removes it from both source and rendered
views.
