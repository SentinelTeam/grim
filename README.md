# Grim: Global Risk Simulator

A Telegram bot for simulating and role-playing global risk scenarios. Players can take on different roles and interact with scenarios through actions and information sharing. You can read more about the motivation behind it here: [Scaling Wargaming for Global Catastrophic Risks with AI](https://blog.sentinel-team.org/p/scaling-wargaming-for-global-catastrophic-risks).

## Prerequisites

1. Install [Bun](https://bun.sh/docs/installation)

## Getting started

1. Clone this repository
2. Install dependencies: with `bun install`
3. Create a `.env` file with the following tokens:

```
TELEGRAM_BOT_TOKEN=your_key
OPENAI_API_KEY=your_key
```

You can get an OpenAI key from [platform.openai.com/settings](https://platform.openai.com/settings), and it should have access to the o1 model, which OpenAI is slowly rolling out. You can get a Telegram bot token by following instructions [here](https://core.telegram.org/bots#how-do-i-create-a-bot) (messaging the @BotFather account on Telegram.)

## Usage

1. Start the bot: `bun src/grim.ts`. Optionally, you can provide a scenario file, `bun src/grim.ts --scenario-file file_name`. There is an example scenario file called `scenario.example.txt` if you want to get up and running quickly.
1. Set your role with `/role <Your Name> - <Your Role>`
1. Start the scenario with `/scenario <scenario_description>`. You don't need to provide `scenario_description` if you used a `scenario_file`
1. Once the scenario is started, you can use these commands:
- `/info` - Queue an information request about the current situation
- `/feed` - Queue information to incorporate into the world state
- `/action` - Queue an action you want to take in the world
- `/process` - Process all queued actions
- `/remove` - Remove an item from the action queue
- `/rollback` - Roll back the scenario to a previous checkpoint

## Contributing

We're happy to do some hand-holding to onboard a contributer who may want to contribute consistently! Feel free to ask for clarification in any of the outstanding issues or [request a call](mailto:hello@sentinel-team.org). If you request a call, quickly describe your background or provide a link to your work. Otherwise, feel free to fork the repo, make pull requests, or make issues suggesting improvements. 

## License

Distributed under the GPL. If this is a hurdle for you, let us know.
