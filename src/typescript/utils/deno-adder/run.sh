#!/usr/bin/env bash

deno add $(echo $(git grep -E '^import ' | awk '{print $NF}' | sed -e 's#https://deno.land/x/#npm:#g' -e 's#/mod.ts##g' | sed -e 's/;//g' -e 's/@\^.*//g' -e 's/@v.*//g' -e 's/"//g' -e 's/@std/jsr:@std/'| grep -vE '^./' | sed -e 's/jsr:jsr:/jsr:/'))
