# Security

Noodlegraph runs graphs that people draw. Two things are worth knowing.

## What a graph can do

A graph can only do what the host application's blocks do. The standard blocks wait, count,
compare and store values; they do not touch files, the network or the page. If you offer
graphs from people you do not trust, look at what your own blocks allow.

The engine limits how long a chain runs, how many steps it takes and how deep loops and graphs
nest, so a graph cannot hold up the host for ever. The limits are yours to set (`limits`).

## Reporting a problem

Please do not open a public issue for something that could harm people who use Noodlegraph.
Write to Eagle Creative (https://eagle-creative.com) with what you found and how to see it.
You will get an answer, and credit in the changelog if you want it.
