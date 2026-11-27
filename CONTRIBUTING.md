# Contributing

Thank you for wanting to improve Noodlegraph.

## Before you send code

Noodlegraph is offered under two licences (see [LICENSE.md](LICENSE.md)). That only works if
Eagle Creative may license every part of it both ways. So with a contribution you confirm:

- you wrote it yourself, or have the right to contribute it;
- you grant Eagle Creative the right to use, change and license it under the AGPL and under
  commercial licences, without limit in time;
- you keep your own copyright in it.

Say so in your pull request ("I agree to the contribution terms in CONTRIBUTING.md").

## How the project is organised

`spec/` is the contract. Editors and runtimes are built against it and share no code.

- A change to how graphs are checked or run goes into `spec/SPEC.md` first, gets a case in
  `spec/tests/cases.json`, and is then made in **every** runtime.
- A change to one runtime or editor that the spec does not mention needs only that
  platform's tests.

## Checks

```
cd runtimes/javascript && npm test
python -m pytest runtimes/python
```

Both must pass. The JavaScript has no dependencies and no build step; please keep it that way.
