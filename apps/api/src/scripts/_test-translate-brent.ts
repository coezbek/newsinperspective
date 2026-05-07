import "../config/env.js";
import { prisma } from "../lib/prisma.js";

(async () => {
  const c = await prisma.storyCluster.findUnique({
    where: { id: "cmomjtywi00mxjj160g0ldsyz" },
    select: { id: true, title: true, storyDate: true, translatedTitle: true },
  });
  console.log(c);
  await prisma.$disconnect();
})();
