import Nav from "@/components/Nav";
import ScrollCakeHero from "@/components/ScrollCakeHero";
import MenuSection from "@/components/MenuSection";
import ProcessSection from "@/components/ProcessSection";
import StorySection from "@/components/StorySection";
import LocationsFooter from "@/components/LocationsFooter";

export default function Home() {
  return (
    <div id="top">
      <Nav />
      <ScrollCakeHero />
      <MenuSection />
      <ProcessSection />
      <StorySection />
      <LocationsFooter />
    </div>
  );
}
