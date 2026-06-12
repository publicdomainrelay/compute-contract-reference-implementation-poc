claude mcp add -t stdio -s local svelte -- npx -y @sveltejs/mcp
cd $(mktemp -d)
curl -fL https://github.com/sveltejs/ai-tools/archive/main.tar.gz | tar xz --wildcards --no-anchored 'tools/skills/*' --strip-components=1
mv -v $(find . -name skills -type d)/* ~/.claude/skills/
cd -
