import { describe, expect, it } from "vitest";
import { mentions, parseIfcQuestion, parseTextQuestion, quotedNames } from "../src/solvers/ifc/question.js";

describe("quoted names", () => {
  it("reads straight and typographic quotes", () => {
    expect(quotedNames("What is the net floor area of the room 'Skakt (Rum nr. 602.1)' on '6. sal', in m²?")).toEqual(["Skakt (Rum nr. 602.1)", "6. sal"]);
    expect(quotedNames("Mitu ust on näidatud korruse „1.korrus“ plaanil?")).toEqual(["1.korrus"]);
  });

  it("keeps an apostrophe inside a name", () => {
    expect(quotedNames("What is the net floor area of the room 'Men's room (12)' on 'Level 1', in m²?")).toEqual(["Men's room (12)", "Level 1"]);
  });
});

describe("room area questions", () => {
  it.each([
    ["What is the net floor area of the room 'KORIDOR (119)' on '1.korrus', in m²?"],
    ["Kui suur on ruumi „KORIDOR (119)“ netopõrandapind korrusel „1.korrus“ (m²)?"],
    ["Hvad er nettoarealet af rummet 'KORIDOR (119)' på '1.korrus' i m²?"],
  ])("%s", (question) => {
    expect(parseIfcQuestion(question, "area")).toEqual({ kind: "area_room", room: "KORIDOR (119)", storey: "1.korrus" });
  });

  it.each([
    ["What is the total net floor area of all rooms (spaces) on '6. sal', in m²?"],
    ["Kui suur on kõigi ruumide netopõrandapind kokku korrusel „6. sal“ (m²)?"],
    ["Hvad er det samlede nettoareal af alle rum på '6. sal' i m²?"],
  ])("%s", (question) => {
    expect(parseIfcQuestion(question, "area")).toEqual({ kind: "area_storey_rooms", storey: "6. sal" });
  });

  it("takes a lone quoted name as the room", () => {
    expect(parseIfcQuestion("What is the area of room 'ARVUTIKLASS'?", "area")).toEqual({ kind: "area_room", room: "ARVUTIKLASS", storey: null });
  });
});

describe("count questions", () => {
  it.each([
    ["How many doors are shown on the floor plan of 'Kælder'?", "door"],
    ["Hvor mange døre er vist på plantegningen for 'Kælder'?", "door"],
    ["Mitu ust on näidatud korruse „Kælder“ plaanil?", "door"],
    ["How many rooms (spaces) are shown on the floor plan of 'Kælder'?", "space"],
    ["Hvor mange rum er vist på plantegningen for 'Kælder'?", "space"],
    ["Mitu ruumi on näidatud korruse „Kælder“ plaanil?", "space"],
    ["Hvor mange vægge er vist på plantegningen for 'Kælder'?", "wall"],
    ["Mitu seina on näidatud korruse „Kælder“ plaanil?", "wall"],
    ["Hvor mange søjler er vist på plantegningen for 'Kælder'?", "column"],
    ["Mitu posti on näidatud korruse „Kælder“ plaanil?", "column"],
    ["Hvor mange trapper er vist på plantegningen for 'Kælder'?", "stair"],
    ["Mitu treppi on näidatud korruse „Kælder“ plaanil?", "stair"],
    ["Hvor mange vinduer er vist på plantegningen for 'Kælder'?", "window"],
    ["Wie viele Fenster sind im Grundriss 'Kælder' dargestellt?", "window"],
  ])("on a storey: %s", (question, element) => {
    expect(parseIfcQuestion(question, "count")).toEqual({ kind: "count", element, scope: "storey", name: "Kælder" });
  });

  it.each([
    ["How many beams are there in the model 'Molio Demo-hus'?", "beam"],
    ["Hvor mange bjælker er der i modellen 'Molio Demo-hus'?", "beam"],
    ["Mitu tala on mudelis „Molio Demo-hus“?", "beam"],
    ["Mitu akent on mudelis „Molio Demo-hus“?", "window"],
    ["Wie viele Türen enthält das Modell 'Molio Demo-hus'?", "door"],
    ["How many sanitary fixtures are there in the model 'Molio Demo-hus'?", "sanitary"],
  ])("in the model: %s", (question, element) => {
    expect(parseIfcQuestion(question, "count")).toEqual({ kind: "count", element, scope: "model", name: "Molio Demo-hus" });
  });

  it("ignores element words inside a quoted name", () => {
    expect(parseIfcQuestion("How many windows are there in the model 'Door factory'?", "count")).toMatchObject({ element: "window" });
  });

  it("returns null for an element it does not know", () => {
    expect(parseIfcQuestion("How many toilets are shown on the floor plan of 'Kælder'?", "count")).toBeNull();
  });
});

describe("wall and slab totals", () => {
  it.each([
    ["What is the total length of all walls on 'Grundplan', in metres?", "length", "wall_length"],
    ["Hvad er den samlede længde af alle vægge på 'Grundplan' i meter?", "length", "wall_length"],
    ["Wie lang sind alle Wände im Geschoss 'Grundplan' zusammen, in Metern?", "length", "wall_length"],
    ["What is the total net side area of all walls on 'Grundplan', in m²?", "area", "wall_side_area"],
    ["Hvad er det samlede nettosideareal af alle vægge på 'Grundplan' i m²?", "area", "wall_side_area"],
    ["Wie groß ist die gesamte Netto-Seitenfläche aller Wände im Geschoss 'Grundplan' in m²?", "area", "wall_side_area"],
    ["What is the total net volume of all walls on 'Grundplan', in m³?", "volume", "wall_volume"],
    ["Hvad er det samlede nettovolumen af alle vægge på 'Grundplan' i m³?", "volume", "wall_volume"],
    ["What is the total net volume of all slabs on 'Grundplan', in m³?", "volume", "slab_volume"],
    ["Hvad er det samlede nettovolumen af alle dæk og plader på 'Grundplan' i m³?", "volume", "slab_volume"],
    ["Wie groß ist das gesamte Netto-Volumen aller Decken und Bodenplatten im Geschoss 'Grundplan' in m³?", "volume", "slab_volume"],
  ] as const)("%s", (question, qtype, kind) => {
    expect(parseIfcQuestion(question, qtype)).toEqual({ kind, storey: "Grundplan" });
  });
});

describe("free-text questions", () => {
  it.each([
    ["What software and ifc standards were used to create this model?", { topic: "software" }],
    ["What are the heights of each level?", { topic: "levels" }],
    ["Which room in the building is the largest?", { topic: "largest_room", smallest: false }],
    ["What is the space breakdown of the basement floor grouped by function with areas?", { topic: "spaces", level: { above: -1 }, listed: true }],
    ["What are all the spaces on level 2, with their areas?", { topic: "spaces", level: { above: 2 }, listed: true }],
    ["Which wall types are used on the exterior side of the building and how many of each?", { topic: "element_types", element: "wall", side: "exterior" }],
    ["Which two doors have the greatest widths in the building?", { topic: "element_widths", element: "door" }],
    ["How many of the walls are load-bearing compared with non-load-bearing?", { topic: "element_property", element: "wall", property: "LoadBearing" }],
  ])("%s", (question, ask) => {
    expect(parseTextQuestion(question)).toEqual(ask);
  });

  it.each([
    ["Which heating systems are included in this building?"],
    ["What are the thicknesses of the various wall types?"],
    ["Which materials are used to construct the walls and their usage across wall types?"],
    ["How many windows are there on the north facade?"],
    ["What furniture can be found in the staff room on the third floor?"],
    ["What are the sizes of the columns?"],
  ])("returns null rather than the nearest fact: %s", (question) => {
    expect(parseTextQuestion(question)).toBeNull();
  });
});

describe("mentions", () => {
  it("finds a storey name only as whole words", () => {
    expect(mentions("how many doors on 3.korrus", "3.korrus")).toBe(true);
    expect(mentions("What are the percentages per stage?", "Tag")).toBe(false);
    expect(mentions("spaces on the tag level", "Tag")).toBe(true);
  });
});
