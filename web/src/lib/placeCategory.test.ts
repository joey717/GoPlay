import { describe, expect, it } from "vitest";
import { classifyPlace, shortPlaceLabel } from "./placeCategory";

describe("classifyPlace 稳定分类", () => {
  it("category 文本优先：category=美食 压过名称中的「市场」（否则会归购物）", () => {
    const info = classifyPlace({ category: "美食", name: "第一市场" });
    expect(info.key).toBe("dining");
    expect(info.label).toBe("餐饮");
  });

  it("category 文本：景点门票归景点", () => {
    expect(classifyPlace({ category: "景点门票", name: "某地" }).key).toBe("sight");
  });

  it("咖啡茶饮：名称含咖啡/奶茶，英文大小写不敏感", () => {
    expect(classifyPlace({ name: "海边咖啡馆" }).key).toBe("coffee");
    expect(classifyPlace({ name: "亚龙湾奶茶铺" }).key).toBe("coffee");
    expect(classifyPlace({ name: "Seaside Cafe" }).key).toBe("coffee");
    expect(classifyPlace({ name: "Duty Free Coffee Shop" }).key).toBe("coffee");
  });

  it("海滩海岛：蜈支洲岛按「岛」命中 beach", () => {
    const info = classifyPlace({ name: "蜈支洲岛" });
    expect(info.key).toBe("beach");
    expect(info.glyph).toBe("海");
  });

  it("餐饮：海鲜加工/餐厅类，不被宽泛词抢先", () => {
    expect(classifyPlace({ name: "第一市场海鲜加工店" }).key).toBe("dining");
    expect(classifyPlace({ name: "林姐香味餐厅" }).key).toBe("dining");
  });

  it("购物：市场/夜市/免税城", () => {
    expect(classifyPlace({ name: "第一市场" }).key).toBe("shopping");
    expect(classifyPlace({ name: "后海夜市" }).key).toBe("shopping");
    expect(classifyPlace({ name: "三亚国际免税城" }).key).toBe("shopping");
  });

  it("住宿交通：机场/酒店/民宿", () => {
    expect(classifyPlace({ name: "凤凰机场" }).key).toBe("stay");
    expect(classifyPlace({ name: "亚特兰蒂斯酒店" }).key).toBe("stay");
    expect(classifyPlace({ name: "后海民宿小院" }).key).toBe("stay");
  });

  it("词表顺序即优先级：「岛」与「码头」并存时按 beach（更靠前）归类", () => {
    expect(classifyPlace({ name: "蜈支洲岛码头" }).key).toBe("beach");
  });

  it("景点：公园/博物馆/寺庙等宽泛词兜底", () => {
    expect(classifyPlace({ name: "亚龙湾热带天堂森林公园" }).key).toBe("sight");
    expect(classifyPlace({ name: "南山寺" }).key).toBe("sight");
  });

  it("大景区兜底：无 category 且名称无关键词时按 kind 归景点", () => {
    expect(classifyPlace({ name: "某某胜地", isLargeAttraction: true }).key).toBe("sight");
  });

  it("全不中回退 generic（地图钉），且 isLargeAttraction=false", () => {
    const info = classifyPlace({ name: "后海村" });
    expect(info.key).toBe("generic");
    expect(info.glyph).toBe("");
    expect(info.label).toBe("地点");
  });

  it("同输入恒同输出（稳定性抽查）", () => {
    const a = classifyPlace({ category: null, name: "椰梦长廊" });
    const b = classifyPlace({ category: null, name: "椰梦长廊" });
    expect(a).toBe(b);
  });
});

describe("shortPlaceLabel 精简短名", () => {
  it("≤4 字直接全显", () => {
    expect(shortPlaceLabel("第一市场")).toBe("第一市场");
    expect(shortPlaceLabel("南山寺")).toBe("南山寺");
  });

  it(">4 字截前 4 字（规则简单可预测）", () => {
    expect(shortPlaceLabel("蜈支洲岛旅游区")).toBe("蜈支洲岛");
    expect(shortPlaceLabel("亚龙湾热带天堂森林公园")).toBe("亚龙湾热");
  });

  it("成对括号内容剥离后再判断", () => {
    expect(shortPlaceLabel("天涯海角（三亚）")).toBe("天涯海角");
    expect(shortPlaceLabel("西岛(西玳瑁岛)海洋新区")).toBe("西岛海洋");
  });

  it("分隔符取首个非空段", () => {
    expect(shortPlaceLabel("南山·海上观音")).toBe("南山");
    expect(shortPlaceLabel("大东海 - 珊瑚保护区")).toBe("大东海");
    expect(shortPlaceLabel("椰梦长廊：日落点")).toBe("椰梦长廊");
  });

  it("空白/空串回退「地点」", () => {
    expect(shortPlaceLabel("   ")).toBe("地点");
    expect(shortPlaceLabel("")).toBe("地点");
  });
});
