This file is read-only for agents.

## Communication

Please remove all mannered prose. Use 80% ASD-STE100 style when writing technical topics for better clarity. Use diagrams to explain complex sequence or relations.

Durable artifacts should contain current solution and lasting decisions, while transient state or history should reach there. For example don't name a test func `test_<feature>_red` during red-green-refactor cycle.

## Behavior

Ask user to clarify when actions may lead to materially different work, otherwise state assumption and proceed.

Plan first when user prompts like "[plan|propose|design|diagnose] <feature>". 

When user ask to "address comments":
1. Check user comments in target files;
2. investigate and come up your opinions;
3. report back and discuss with user with listing grouped by topics;
4. no edit until agreement reached or user approval. 

Update the active plan file, for example`[plans|<feature>].md`) or other artifacts as decisions land.

## Coding

Attack the essential complexity of the problem, reasonable engineering tradeoffs still apply. Reduce accidental complexity by design from the first principles. Keep solution simple and stupid, no overengineering.

Write codes whose intent is obvious. Write no code comments. 

Use TDD by default:
- Test behavior not implementation detail.
- Prioritize test case of deep, vertical slice of the system. Tests must pin down system contracts and important behaviors.
- Prefer extending an existing case over adding a new one for the same API. This prevents fragmentation where each case asserts only part of the API contract.

### Git

- No stage or commit unless asked. 
- Use one-liner commit message.

## Subagents 

The main session is for design and conversation with the user. Keep planning and decisions there. Anything that can block it for more than a moment, such as long or unbounded commands, bulk reads, goes to a subagent or the background even when a tool description suggests one inline script would suffice. A blocked main session stalls the design flow.

Subagent routing rules:
1. Claude Code, follow profiles.
2. Codex/Pi, use gpt-6.1-sol for subagent by default.


