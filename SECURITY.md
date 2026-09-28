# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it
privately instead, from this repo's **Security** tab → **Report a
vulnerability**. Only the maintainer can see the report.

Include what you found, how to reproduce it, and which version you tested. You
should get a reply within a week.

## Scope

The extension runs on Salesforce pages and reads data from them, so the things
that matter most are:

- anything that sends page data off the machine (it should never make a network
  request);
- anything that lets a web page read or change what the extension stores, or
  drive the extension in ways it shouldn't;
- permissions broader than the extension needs.

If you accidentally committed real org data in a pull request, say so in the
PR and close it. The maintainer will help you remove it.
