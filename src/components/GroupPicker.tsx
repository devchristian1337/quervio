import { useMemo, useState } from "react";
import { Combobox, createListCollection } from "@ark-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useScrollFadeRef } from "@/components/ui/scroll-fade";

/** Existing groups as themed suggestions; an empty or new name is valid too. */
export function GroupPicker({ groups, value, onChange }: {
  groups: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const fadeList = useScrollFadeRef<HTMLDivElement>();
  const collection = useMemo(() => createListCollection({
    items: groups.filter((group) => group.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  }), [groups, query]);

  return (
    <Combobox.Root
      collection={collection}
      ids={{ input: "group" }}
      open={expanded}
      value={groups.includes(value) ? [value] : []}
      inputValue={value}
      allowCustomValue
      selectionBehavior="preserve"
      openOnClick
      closeOnSelect
      positioning={{ placement: "bottom-start", sameWidth: true, gutter: 4 }}
      translations={{ triggerLabel: "Show groups" }}
      onInputValueChange={({ inputValue, reason }) => {
        if (reason === "input-change") {
          setQuery(inputValue);
          onChange(inputValue);
        }
      }}
      onValueChange={({ value: selected }) => {
        if (selected[0] !== undefined) {
          onChange(selected[0]);
          setQuery("");
        }
      }}
      onOpenChange={({ open, reason }) => {
        setExpanded(open);
        if (open && (reason === "trigger-click" || reason === "input-click")) setQuery("");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
        }
      }}
    >
      <Combobox.Control className="relative">
        <Combobox.Input asChild>
          <Input placeholder="None: at the top of the Object Explorer" className="pr-9" />
        </Combobox.Input>
        <Combobox.Trigger className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <ChevronDown className="size-4" />
        </Combobox.Trigger>
      </Combobox.Control>
      <Combobox.Positioner className="z-50">
        <Combobox.Content className="w-full overflow-hidden rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none">
          <Combobox.List ref={fadeList} className="max-h-52 overflow-y-auto">
            {collection.items.map((group) => (
              <Combobox.Item key={group} item={group} className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                <Combobox.ItemText className="truncate" title={group}>{group}</Combobox.ItemText>
                <Combobox.ItemIndicator><Check className="size-4 shrink-0" /></Combobox.ItemIndicator>
              </Combobox.Item>
            ))}
          </Combobox.List>
          {collection.items.length === 0 && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">No matching groups. You can type a new name.</p>}
        </Combobox.Content>
      </Combobox.Positioner>
    </Combobox.Root>
  );
}
