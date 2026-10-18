# Hermes integration

Files for connecting the [Hermes](https://github.com/NousResearch/hermes-agent) agent (WhatsApp front end) to Workboard.

| File | What it is |
| --- | --- |
| `SKILL.md` | The agent skill. Copy it into Hermes' skills directory (`skills/productivity/workboard/SKILL.md`). It teaches the agent to use the `mcp_workboard_*` tools. |
| `config.example.yaml` | The Hermes `config.yaml` fragments: the MCP server, the webhook route that delivers reminders, and WhatsApp group settings. |

Workboard exposes its tools over MCP at `POST /mcp` and sends reminders, the morning digest and pairing codes
through a signed webhook that Hermes forwards to WhatsApp.

Full walkthrough, webhook contract, multi-person setup and troubleshooting: [docs/hermes.md](../../docs/hermes.md).
