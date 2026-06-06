# Compute Contract Lexicons

[atproto lexicon](https://atproto.com/specs/lexicon) schemas for the compute
contract record types.

The schemas are pre-stable and use the `temp` infix convention:
`com.publicdomainrelay.temp.<name>`. The path on disk mirrors the NSID
(each segment is a directory, the last segment is the filename).

Once a schema stabilizes, it is promoted to `com.publicdomainrelay.<name>`
and evolved additively over time. Genuinely incompatible breaks bump the
short name (`<name>V2`, `<name>V3`, ...).
