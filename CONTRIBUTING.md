# Contributing to WebSpider

Thanks for taking the time to help. This project is small, dependency-free and
deliberately boring to work on — please keep it that way.

## Ground rules

1. **No build step, no framework, no bundler.** Plain HTML, CSS and JavaScript only.
   The extension must keep loading straight from a checkout via *Load unpacked*.
2. **`background.js` is the only ES module.** `sidepanel.js`, `content.js` and `main.js`
   must stay classic scripts — content scripts cannot use `import`.
3. **Never rename a storage key.** `chatSessions`, `activeSession`, `agentState` and the
   settings keys are a data contract. Renaming one silently wipes user history.
4. **Never break the four-way tool wiring.** A tool exists in up to four places — `TOOLS`
   in `background.js`, an `act()` branch, a content-script `HANDLERS` entry, and a
   `TOOLS_INFO` row in `sidepanel.js`. Add all of them or none.
5. **CAPTCHA is detected, never solved.** WebSpider pauses, hands the challenge to the
   user and resumes automatically. Pull requests that solve, click, interpret or bypass a
   challenge will be closed.

## Before you open a pull request

Run the suite and make sure it is green:

```
NODE_PATH=<node-workspace>/node_modules node .workbuddy-ai/tools/run-suite.mjs
```

The expected result is **661 assertions plus 12 static checks, 0 failures**.

If you add or change a guard, **prove it by injecting the bug it is meant to catch** and
watching the suite fail. A guard that stays green under its own bug is decoration.

## Reporting a bug

A useful report contains:

- what you asked WebSpider to do (the exact instruction),
- what you expected, and what happened instead,
- the panel's error text, if any,
- Chrome version and the model/endpoint you are using.

Please do not paste API keys.

## Style

- Keep the existing formatting and comment style; comments explain *why*, not *what*.
- User-facing strings must be added to **both** the `en` and `fa` dictionaries in
  `sidepanel.js`.
- RTL: use logical properties (`margin-inline`, `inset-inline`, `border-start-*`) only.
