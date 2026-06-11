// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { getFieldIcon } from "utils/icon";
import { IconButton } from "components/ui/icon-button";
import { Toggletip } from "components/ui/toggletip";
import { TopData } from "./top-data/top-data";
import { topDataFieldNameAtom } from "store/discover";

interface FieldItemProps {
  field: any;
  onAdd?: (field: any) => void;
  onRemove?: (field: any) => void;
  type: "add" | "remove";
}

export default function FieldItem(props: FieldItemProps) {
  const { field } = props;
  const setTopDataFieldName = useSetAtom(topDataFieldNameAtom);
  const [show, setShow] = useState(false);
  field.key = field.Field;
  if (field.children) {
    field.icon = <div className="text-n4 w-4 text-sm leading-8">{}</div>;
    return (
      <div className="-ml-3 flex">
        Tree
        {/* <Tree showIcon className={`${TreeStyle} ${DiscoverTreeStyle}`} treeData={[field]} switcherIcon={<SDIcon type="icon-arrow-down" className="dark:text-n6" />} /> */}
      </div>
    );
  }
  // Trigger fetch when show becomes true (genuine user open)
  useEffect(() => {
    if (show) {
      setTopDataFieldName(field.Field);
    }
  }, [show, field.Field, setTopDataFieldName]);
  return (
    <div>
      <Toggletip
        placement="right"
        content={<TopData field={field} />}
        show={show}
        onOpen={() => {
          setShow(true);
        }}
        onClose={() => {
          setShow(false);
        }}
      >
        <div className="group hover:bg-muted/50 flex min-h-6 w-full cursor-pointer items-center justify-between gap-2 px-2 text-left">
          <div className="flex min-w-0 items-center gap-1">
            <div className="text-muted-foreground inline-flex h-6 w-6 shrink-0 items-center justify-center">
              {getFieldIcon(field["Type"])}
            </div>
            <div className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center justify-between gap-1 overflow-hidden py-1.5 text-sm font-normal text-ellipsis whitespace-nowrap hover:no-underline [&[data-state=open]>svg]:rotate-180">
              {field["Field"]}
            </div>
          </div>
          <div className="text-muted-foreground hover:text-foreground ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100">
            {props.type === "add" ? (
              <IconButton
                name="plus"
                size="sm"
                tooltip="Add to table"
                onClick={(e) => {
                  props?.onAdd?.(field);
                  e.stopPropagation();
                }}
              />
            ) : (
              <IconButton
                name="minus"
                size="sm"
                tooltip="Remove from table"
                onClick={(e: any) => {
                  props?.onRemove?.(field);
                  e.stopPropagation();
                }}
              />
            )}
          </div>
        </div>
      </Toggletip>
    </div>
  );
}
