// @ts-nocheck
import React from "react";
import { useAtom } from "jotai";
import { searchValueAtom } from "store/discover";
import { Input } from "components/ui/input";

export default function Lucene() {
  const [searchValue, setSearchValue] = useAtom(searchValueAtom);
  if (process.env.NODE_ENV !== "production") {
    searchValueAtom.debugLabel = "searchValue";
  }

  return (
    <Input
      value={searchValue}
      onChange={(e: any) => {
        console.log(e);
        setSearchValue(e.target?.value);
      }}
      placeholder="usage: field:value AND field2:value2"
    />
  );
}
