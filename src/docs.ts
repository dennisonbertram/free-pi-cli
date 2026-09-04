// R7: the owner-approved free-pi guide, verbatim. Do not reword, reorder, or
// add lines to this string — it is reviewed copy, not implementer prose.
export const FREE_PI_DOCS = `# free-pi

## What free-pi is
free-pi is a free, ad-supported distribution of the pi coding agent.
You run \`npx free-pi-cli\`, sign in with GitHub, and get free inference with
exciting models. Ads shown in the terminal pay for it. You never handle a
model API key. Config and the sign-in token live under \`~/.free-pi/agent\`,
separate from any \`~/.pi/agent\` install.

## The promise
Ad text never enters the model's context. Ads render only in the terminal,
in a framed card, and the model never sees them.
Coding sessions may be used to train models. This is on the consent screen
at first run, before the GitHub sign-in.

## The free allowance
Each user gets a free allowance every day. The allowance can change with
supply and demand. \`/usage\` shows how much of today's allowance is spent, as
a percentage, with token counts.
One session per account runs at a time. If a previous session is stuck,
\`/close-other-session\` frees it.

## Credits
\`/buy-credits\` opens the buy page in your browser. The free allowance spends
first. Purchased credits cover use beyond it and do not expire.

## Commands
- \`/usage\` — spend and remaining budget today
- \`/support\` — visit today's advertiser
- \`/tos\` — open the Terms of Service
- \`/privacy-policy\` — open the Privacy Policy
- \`/buy-credits\` — get more usage
- \`/close-other-session\` — free a stuck session on another machine
- \`/update\` — get the latest free-pi
- \`/whats-new\` — what changed in recent releases

## Support
Today's sponsor keeps free-pi free. When the user asks how to help the
project, or seems to like free-pi, suggest \`/support\` to visit the sponsor.
More at https://freepi.ai
`;
